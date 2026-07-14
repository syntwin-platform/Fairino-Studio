import {
  BackendSimulatorConfig,
  BackendSimulatorStatus,
  DeviceTelemetryPayload,
  PendingDeviceCommand,
  TcpPose
} from '../types/backendDevice'
import { cancelActiveCommandForRobot, getActiveCommandIdForRobot } from './commandExecutionRuntime'
import { useRobotStore } from '../store/robotStore'
import { useSceneStore } from '../store/sceneStore'
import {
  getPendingCommand,
  postCommandResult,
  postFactoryRunArmed,
  postHeartbeat,
  postFactoryRunStarted,
  postTelemetry
} from './backendDeviceClient'
import { executeBackendCommand, getCommandExecutionFailureMetadata } from './backendCommandExecutor'
import { withDeviceToken } from './backendDeviceSession'

interface BackendDeviceSimulatorCallbacks {
  onStatusChange: (status: Partial<BackendSimulatorStatus>) => void
  onLog?: (message: string) => void
}

interface BackendDeviceSimulatorSessionState {
  heartbeatTimer: ReturnType<typeof setInterval> | null
  telemetryTimer: ReturnType<typeof setInterval> | null
  heartbeatInFlight: boolean
  telemetryInFlight: boolean
  commandExecutionInFlight: boolean
  commandPollAbortController: AbortController | null
  running: boolean
  runId: number
}

function createSessionState(): BackendDeviceSimulatorSessionState {
  return {
    heartbeatTimer: null,
    telemetryTimer: null,
    heartbeatInFlight: false,
    telemetryInFlight: false,
    commandExecutionInFlight: false,
    commandPollAbortController: null,
    running: false,
    runId: 0
  }
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateTcpPose(tcpPose: TcpPose): void {
  const requiredKeys: Array<keyof TcpPose> = ['x', 'y', 'z', 'rx', 'ry', 'rz']

  for (const key of requiredKeys) {
    if (!isFiniteNumber(tcpPose[key])) {
      throw new Error(`TCP pose field ${key} must be a finite number`)
    }
  }
}

function validateJointAngles(jointAngles: number[]): void {
  if (!Array.isArray(jointAngles)) throw new Error('Joint angles must be an array')
  if (jointAngles.length !== 6) throw new Error('Joint angles must contain exactly 6 values')

  for (const angle of jointAngles) {
    if (!isFiniteNumber(angle)) {
      throw new Error('Every joint angle must be a finite number')
    }
  }
}

function validateConfig(config: BackendSimulatorConfig): void {
  if (!config.backendUrl.trim()) throw new Error('Backend URL is required')
  if (!config.robotId.trim()) throw new Error('Robot ID is required')
  if (!isGuid(config.robotId.trim())) throw new Error('Robot ID should be a valid GUID')
  if (!config.deviceSecret.trim()) throw new Error('Device Secret is required')

  if (!Number.isFinite(config.heartbeatIntervalMs) || config.heartbeatIntervalMs < 1000) {
    throw new Error('Heartbeat interval must be at least 1000ms')
  }

  if (!Number.isFinite(config.telemetryIntervalMs) || config.telemetryIntervalMs < 250) {
    throw new Error('Telemetry interval must be at least 250ms')
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function buildTelemetryFromStores(config: BackendSimulatorConfig): DeviceTelemetryPayload {
  const robotState = useRobotStore.getState()
  const sceneState = useSceneStore.getState()
  const robotId = config.robotId.trim()

  const jointAngles = [...(robotState.jointAnglesByRobotId[robotId] ?? robotState.jointAngles)]
  const tcpPose = {
    ...(robotState.tcpPoseByRobotId[robotId] ?? robotState.tcpPose)
  }

  validateJointAngles(jointAngles)
  validateTcpPose(tcpPose)

  return {
    robotId: config.robotId,
    tcpPose,
    jointAngles,
    temperature: null,
    statusCode: robotState.robotExecutionById[robotId]?.isPlaying ? 'RUNNING' : 'IDLE',
    collisionWarning: sceneState.robotContactsById[robotId]?.level === 'collision',
    timestamp: new Date().toISOString()
  }
}

async function sendHeartbeat(
  config: BackendSimulatorConfig,
  callbacks: BackendDeviceSimulatorCallbacks,
  currentRunId: number,
  session: BackendDeviceSimulatorSessionState
): Promise<void> {
  if (session.heartbeatInFlight) return
  session.heartbeatInFlight = true

  try {
    await withDeviceToken(config, (token) => postHeartbeat(config, token))
    if (session.runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: true,
      lastHeartbeatAt: new Date().toISOString(),
      lastError: undefined
    })
  } catch (error) {
    if (session.runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: false,
      lastError: error instanceof Error ? error.message : 'Heartbeat failed'
    })
  } finally {
    session.heartbeatInFlight = false
  }
}

async function sendTelemetry(
  config: BackendSimulatorConfig,
  callbacks: BackendDeviceSimulatorCallbacks,
  currentRunId: number,
  session: BackendDeviceSimulatorSessionState
): Promise<void> {
  if (session.telemetryInFlight) return
  session.telemetryInFlight = true

  try {
    const telemetry = buildTelemetryFromStores(config)
    await withDeviceToken(config, (token) => postTelemetry(config, telemetry, token))

    if (session.runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: true,
      lastTelemetryAt: new Date().toISOString(),
      lastError: undefined
    })
  } catch (error) {
    if (session.runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: false,
      lastError: error instanceof Error ? error.message : 'Telemetry failed'
    })
  } finally {
    session.telemetryInFlight = false
  }
}

async function executeAndReportCommand(
  config: BackendSimulatorConfig,
  command: PendingDeviceCommand,
  callbacks: BackendDeviceSimulatorCallbacks,
  currentRunId: number,
  session: BackendDeviceSimulatorSessionState
): Promise<void> {
  let commandSucceeded = true
  let commandMessage = 'Simulated command executed in Fairino-Studio'
  let failureMetadata: ReturnType<typeof getCommandExecutionFailureMetadata> = null

  const receivedAtUtc = new Date().toISOString()

  try {
    await executeBackendCommand(command, {
      armFactoryRunCommand: async (payload, estimatedStepDurationsMs, signal) => {
        return await withDeviceToken(config, (token) =>
          postFactoryRunArmed(
            config,
            {
              factoryRunId: payload.factoryRunId,
              targetId: payload.targetId,
              commandId: command.commandId,
              robotId: command.robotId,
              receivedAtUtc,
              armedAtUtc: new Date().toISOString(),
              estimatedStepDurationsMs
            },
            token,
            signal
          )
        )
      },

      reportFactoryRunStarted: async (payload, actualStartedAtUtc, signal) => {
        await withDeviceToken(config, (token) =>
          postFactoryRunStarted(
            config,
            {
              factoryRunId: payload.factoryRunId,
              targetId: payload.targetId,
              commandId: command.commandId,
              robotId: command.robotId,
              actualStartedAtUtc
            },
            token,
            signal
          )
        )
      }
    })
  } catch (error) {
    commandSucceeded = false
    commandMessage = error instanceof Error ? error.message : 'Command execution failed'
    failureMetadata = getCommandExecutionFailureMetadata(error)
  }

  commandMessage = commandMessage.slice(0, 500)

  try {
    await withDeviceToken(config, (token) =>
      postCommandResult(
        config,
        {
          commandId: command.commandId,
          robotId: config.robotId,
          success: commandSucceeded,
          status: commandSucceeded ? 'Completed' : 'Failed',
          message: commandMessage,
          rawPayload: {
            source: 'Fairino-Studio Electron Simulator',
            commandType: command.commandType,
            failure: failureMetadata
          },
          completedAt: new Date().toISOString()
        },
        token
      )
    )

    if (session.runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: true,
      lastResultAt: new Date().toISOString(),
      lastError: commandSucceeded ? undefined : `Command failed: ${commandMessage}`
    })
  } catch (error) {
    if (session.runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: false,
      lastError: error instanceof Error ? error.message : 'Command result submission failed'
    })
  }
}

async function handlePendingCommand(
  config: BackendSimulatorConfig,
  command: PendingDeviceCommand,
  callbacks: BackendDeviceSimulatorCallbacks,
  currentRunId: number,
  session: BackendDeviceSimulatorSessionState
): Promise<void> {
  callbacks.onStatusChange({
    isConnected: true,
    lastCommandAt: new Date().toISOString(),
    lastError: undefined
  })

  callbacks.onLog?.(`Received command ${command.commandType} (${command.commandId})`)

  if (
    command.commandType === 'RunProgram' &&
    command.payload &&
    typeof command.payload === 'object'
  ) {
    const scheduledStartAtUtc = (command.payload as { scheduledStartAtUtc?: unknown })
      .scheduledStartAtUtc

    if (typeof scheduledStartAtUtc === 'string') {
      const receivedAtMs = Date.now()
      const scheduledAtMs = Date.parse(scheduledStartAtUtc)
      const startDeltaMs = scheduledAtMs - receivedAtMs

      callbacks.onLog?.(
        `RunProgram scheduledStartAtUtc: ${scheduledStartAtUtc}; ` +
          `receivedAtUtc: ${new Date(receivedAtMs).toISOString()}; ` +
          `startDeltaMs: ${Math.round(startDeltaMs)}`
      )
    }
  }

  if (command.commandType === 'EStop') {
    void executeAndReportCommand(config, command, callbacks, currentRunId, session)
    return
  }

  if (session.commandExecutionInFlight || getActiveCommandIdForRobot(config.robotId) !== null) {
    callbacks.onStatusChange({
      lastError: `Backend returned ${command.commandType} while robot is busy`
    })

    return
  }

  session.commandExecutionInFlight = true

  void executeAndReportCommand(config, command, callbacks, currentRunId, session).finally(() => {
    session.commandExecutionInFlight = false

    // Command vừa kết thúc nhưng vòng poll có thể vẫn đang chờ với isBusy=true.
    // Abort để loop lập tức poll lại normal queue với isBusy=false.
    session.commandPollAbortController?.abort()
  })
}

async function runCommandLongPollLoop(
  config: BackendSimulatorConfig,
  callbacks: BackendDeviceSimulatorCallbacks,
  currentRunId: number,
  session: BackendDeviceSimulatorSessionState
): Promise<void> {
  while (session.running && session.runId === currentRunId) {
    try {
      const isBusy =
        session.commandExecutionInFlight || getActiveCommandIdForRobot(config.robotId) !== null

      session.commandPollAbortController = new AbortController()

      const command = await withDeviceToken(config, (token) =>
        getPendingCommand(config, token, isBusy, session.commandPollAbortController?.signal)
      )

      if (session.runId !== currentRunId) {
        return
      }

      if (command === null) {
        continue
      }

      await handlePendingCommand(config, command, callbacks, currentRunId, session)
    } catch (error) {
      session.commandPollAbortController = null

      if (session.runId !== currentRunId) {
        return
      }

      if (error instanceof DOMException && error.name === 'AbortError') {
        if (session.running && session.runId === currentRunId) {
          continue
        }

        return
      }

      callbacks.onStatusChange({
        isConnected: false,
        lastError: error instanceof Error ? error.message : 'Command polling failed'
      })

      await delay(1000)
    }
  }
}

export interface BackendDeviceSimulatorSessionApi {
  start(config: BackendSimulatorConfig, callbacks: BackendDeviceSimulatorCallbacks): void
  stop(): void
  isRunning(): boolean
}

export function createBackendDeviceSimulatorSession(): BackendDeviceSimulatorSessionApi {
  const session = createSessionState()
  let activeRobotId = ''

  return {
    start(config, callbacks): void {
      if (session.running) this.stop()

      const normalizedConfig: BackendSimulatorConfig = {
        ...config,
        backendUrl: config.backendUrl.trim(),
        robotId: config.robotId.trim(),
        deviceSecret: config.deviceSecret.trim()
      }

      validateConfig(normalizedConfig)
      activeRobotId = normalizedConfig.robotId

      session.running = true
      session.runId += 1
      const currentRunId = session.runId

      callbacks.onStatusChange({
        isRunning: true,
        isConnected: false,
        lastError: undefined
      })

      callbacks.onLog?.('Backend simulator heartbeat and telemetry started.')

      void sendHeartbeat(normalizedConfig, callbacks, currentRunId, session)
      void sendTelemetry(normalizedConfig, callbacks, currentRunId, session)
      void runCommandLongPollLoop(normalizedConfig, callbacks, currentRunId, session)

      session.heartbeatTimer = setInterval(() => {
        void sendHeartbeat(normalizedConfig, callbacks, currentRunId, session)
      }, normalizedConfig.heartbeatIntervalMs)

      session.telemetryTimer = setInterval(() => {
        void sendTelemetry(normalizedConfig, callbacks, currentRunId, session)
      }, normalizedConfig.telemetryIntervalMs)
    },

    stop(): void {
      cancelActiveCommandForRobot(activeRobotId, 'Backend simulator disconnected')
      session.runId += 1

      if (session.heartbeatTimer) {
        clearInterval(session.heartbeatTimer)
        session.heartbeatTimer = null
      }

      if (session.telemetryTimer) {
        clearInterval(session.telemetryTimer)
        session.telemetryTimer = null
      }

      session.commandPollAbortController?.abort()
      session.commandPollAbortController = null

      session.heartbeatInFlight = false
      session.telemetryInFlight = false
      session.commandExecutionInFlight = false
      session.running = false
    },

    isRunning(): boolean {
      return session.running
    }
  }
}

export const backendDeviceSimulator = createBackendDeviceSimulatorSession()

const simulatorSessionsByRobotId = new Map<string, BackendDeviceSimulatorSessionApi>()

export const backendDeviceSimulatorManager = {
  start(config: BackendSimulatorConfig, callbacks: BackendDeviceSimulatorCallbacks): void {
    const robotId = config.robotId.trim()
    if (!robotId) throw new Error('Robot ID is required')

    let session = simulatorSessionsByRobotId.get(robotId)

    if (!session) {
      session = createBackendDeviceSimulatorSession()
      simulatorSessionsByRobotId.set(robotId, session)
    }

    session.start(config, callbacks)
  },

  stop(robotId: string): void {
    const normalizedRobotId = robotId.trim()
    const session = simulatorSessionsByRobotId.get(normalizedRobotId)

    if (!session) return

    session.stop()
    simulatorSessionsByRobotId.delete(normalizedRobotId)
  },

  stopAll(): void {
    for (const session of simulatorSessionsByRobotId.values()) {
      session.stop()
    }

    simulatorSessionsByRobotId.clear()
  },

  isRunning(robotId: string): boolean {
    return simulatorSessionsByRobotId.get(robotId.trim())?.isRunning() ?? false
  }
}
