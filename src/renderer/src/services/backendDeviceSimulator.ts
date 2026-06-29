import {
  BackendSimulatorConfig,
  BackendSimulatorStatus,
  DeviceTelemetryPayload,
  PendingDeviceCommand,
  TcpPose
} from '../types/backendDevice'
import { cancelActiveCommand, getActiveCommandId } from './commandExecutionRuntime'
import { useRobotStore } from '../store/robotStore'
import { useSceneStore } from '../store/sceneStore'
import {
  getPendingCommand,
  postCommandResult,
  postHeartbeat,
  postTelemetry
} from './backendDeviceClient'
import { executeBackendCommand, getCommandExecutionFailureMetadata } from './backendCommandExecutor'
import { withDeviceToken } from './backendDeviceSession'

interface BackendDeviceSimulatorCallbacks {
  onStatusChange: (status: Partial<BackendSimulatorStatus>) => void
  onLog?: (message: string) => void
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let telemetryTimer: ReturnType<typeof setInterval> | null = null

let heartbeatInFlight = false
let telemetryInFlight = false

// Command thường vẫn có thể chạy trong khi request polling tiếp tục.
let commandExecutionInFlight = false

let commandPollAbortController: AbortController | null = null

let running = false
let runId = 0

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

  if (!Number.isFinite(config.telemetryIntervalMs) || config.telemetryIntervalMs < 100) {
    throw new Error('Telemetry interval must be at least 100ms')
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function buildTelemetryFromStores(config: BackendSimulatorConfig): DeviceTelemetryPayload {
  const robotState = useRobotStore.getState()
  const sceneState = useSceneStore.getState()

  const jointAngles = [...robotState.jointAngles]
  const tcpPose = { ...robotState.tcpPose }

  validateJointAngles(jointAngles)
  validateTcpPose(tcpPose)

  return {
    robotId: config.robotId,
    tcpPose,
    jointAngles,
    temperature: null,
    statusCode: robotState.isPlaying ? 'RUNNING' : 'IDLE',
    collisionWarning: sceneState.collisionWarning,
    timestamp: new Date().toISOString()
  }
}

async function sendHeartbeat(
  config: BackendSimulatorConfig,
  callbacks: BackendDeviceSimulatorCallbacks,
  currentRunId: number
): Promise<void> {
  if (heartbeatInFlight) return
  heartbeatInFlight = true

  try {
    await withDeviceToken(config, (token) => postHeartbeat(config, token))
    if (runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: true,
      lastHeartbeatAt: new Date().toISOString(),
      lastError: undefined
    })
  } catch (error) {
    if (runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: false,
      lastError: error instanceof Error ? error.message : 'Heartbeat failed'
    })
  } finally {
    heartbeatInFlight = false
  }
}

async function sendTelemetry(
  config: BackendSimulatorConfig,
  callbacks: BackendDeviceSimulatorCallbacks,
  currentRunId: number
): Promise<void> {
  if (telemetryInFlight) return
  telemetryInFlight = true

  try {
    const telemetry = buildTelemetryFromStores(config)
    await withDeviceToken(config, (token) => postTelemetry(config, telemetry, token))

    if (runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: true,
      lastTelemetryAt: new Date().toISOString(),
      lastError: undefined
    })
  } catch (error) {
    if (runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: false,
      lastError: error instanceof Error ? error.message : 'Telemetry failed'
    })
  } finally {
    telemetryInFlight = false
  }
}

async function executeAndReportCommand(
  config: BackendSimulatorConfig,
  command: PendingDeviceCommand,
  callbacks: BackendDeviceSimulatorCallbacks,
  currentRunId: number
): Promise<void> {
  let commandSucceeded = true
  let commandMessage = 'Simulated command executed in Fairino-Studio'
  let failureMetadata: ReturnType<typeof getCommandExecutionFailureMetadata> = null
  try {
    await executeBackendCommand(command)
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

    if (runId !== currentRunId) return

    callbacks.onStatusChange({
      isConnected: true,
      lastResultAt: new Date().toISOString(),
      lastError: commandSucceeded ? undefined : `Command failed: ${commandMessage}`
    })
  } catch (error) {
    if (runId !== currentRunId) return

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
  currentRunId: number
): Promise<void> {
  callbacks.onStatusChange({
    isConnected: true,
    lastCommandAt: new Date().toISOString(),
    lastError: undefined
  })

  callbacks.onLog?.(`Received command ${command.commandType} (${command.commandId})`)

  if (command.commandType === 'EStop') {
    // Không await. EStop chạy song song và cancel command hiện tại ngay lập tức.
    void executeAndReportCommand(config, command, callbacks, currentRunId)

    return
  }

  if (commandExecutionInFlight || getActiveCommandId() !== null) {
    callbacks.onStatusChange({
      lastError: `Backend returned ${command.commandType} while robot is busy`
    })

    return
  }

  commandExecutionInFlight = true

  // Không await tại đây. Polling phải tiếp tục để nhận EStop.
  void executeAndReportCommand(config, command, callbacks, currentRunId).finally(() => {
    commandExecutionInFlight = false
  })
}

async function runCommandLongPollLoop(
  config: BackendSimulatorConfig,
  callbacks: BackendDeviceSimulatorCallbacks,
  currentRunId: number
): Promise<void> {
  while (running && runId === currentRunId) {
    try {
      const isBusy = commandExecutionInFlight || getActiveCommandId() !== null

      commandPollAbortController = new AbortController()

      const command = await withDeviceToken(config, (token) =>
        getPendingCommand(config, token, isBusy, commandPollAbortController?.signal)
      )

      commandPollAbortController = null

      if (runId !== currentRunId) {
        return
      }

      if (command === null) {
        continue
      }

      await handlePendingCommand(config, command, callbacks, currentRunId)
    } catch (error) {
      commandPollAbortController = null

      if (runId !== currentRunId) {
        return
      }

      if (error instanceof DOMException && error.name === 'AbortError') {
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

export const backendDeviceSimulator = {
  start(config: BackendSimulatorConfig, callbacks: BackendDeviceSimulatorCallbacks): void {
    if (running) this.stop()

    const normalizedConfig: BackendSimulatorConfig = {
      ...config,
      backendUrl: config.backendUrl.trim(),
      robotId: config.robotId.trim(),
      deviceSecret: config.deviceSecret.trim()
    }

    validateConfig(normalizedConfig)

    running = true
    runId += 1
    const currentRunId = runId

    callbacks.onStatusChange({
      isRunning: true,
      isConnected: false,
      lastError: undefined
    })

    callbacks.onLog?.('Backend simulator heartbeat and telemetry started.')

    void sendHeartbeat(normalizedConfig, callbacks, currentRunId)
    void sendTelemetry(normalizedConfig, callbacks, currentRunId)
    void runCommandLongPollLoop(normalizedConfig, callbacks, currentRunId)

    heartbeatTimer = setInterval(() => {
      void sendHeartbeat(normalizedConfig, callbacks, currentRunId)
    }, normalizedConfig.heartbeatIntervalMs)

    telemetryTimer = setInterval(() => {
      void sendTelemetry(normalizedConfig, callbacks, currentRunId)
    }, normalizedConfig.telemetryIntervalMs)
  },

  stop(): void {
    cancelActiveCommand('Backend simulator disconnected')
    runId += 1

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }

    if (telemetryTimer) {
      clearInterval(telemetryTimer)
      telemetryTimer = null
    }

    commandPollAbortController?.abort()
    commandPollAbortController = null

    heartbeatInFlight = false
    telemetryInFlight = false
    commandExecutionInFlight = false
    running = false
  },

  isRunning(): boolean {
    return running
  }
}
