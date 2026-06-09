import {
  BackendSimulatorConfig,
  BackendSimulatorStatus,
  DeviceTelemetryPayload,
  TcpPose
} from '../types/backendDevice'
import { useRobotStore } from '../store/robotStore'
import { useSceneStore } from '../store/sceneStore'
import {
  getPendingCommand,
  postCommandResult,
  postHeartbeat,
  postTelemetry
} from './backendDeviceClient'
import { executeBackendCommand } from './backendCommandExecutor'

interface BackendDeviceSimulatorCallbacks {
  onStatusChange: (status: Partial<BackendSimulatorStatus>) => void
  onLog?: (message: string) => void
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let telemetryTimer: ReturnType<typeof setInterval> | null = null
let commandPollTimer: ReturnType<typeof setInterval> | null = null

let heartbeatInFlight = false
let telemetryInFlight = false
let commandPollInFlight = false
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

  if (!Number.isFinite(config.commandPollIntervalMs) || config.commandPollIntervalMs < 300) {
    throw new Error('Command poll interval must be at least 300ms')
  }
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
    await postHeartbeat(config)
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
    await postTelemetry(config, telemetry)

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

async function pollCommand(
  config: BackendSimulatorConfig,
  callbacks: BackendDeviceSimulatorCallbacks,
  currentRunId: number
): Promise<void> {
  if (commandPollInFlight) return

  commandPollInFlight = true

  try {
    const command = await getPendingCommand(config)

    if (runId !== currentRunId || command === null) return

    callbacks.onStatusChange({
      isConnected: true,
      lastCommandAt: new Date().toISOString(),
      lastError: undefined
    })

    callbacks.onLog?.(`Received command ${command.commandType} (${command.commandId})`)

    let commandSucceeded = true
    let commandMessage = 'Simulated command executed in Fairino-Studio'

    try {
      await executeBackendCommand(command)
    } catch (error) {
      commandSucceeded = false
      commandMessage = error instanceof Error ? error.message : 'Command execution failed'
    }

    commandMessage = commandMessage.slice(0, 500)

    await postCommandResult(config, {
      commandId: command.commandId,
      robotId: config.robotId,
      success: commandSucceeded,
      status: commandSucceeded ? 'Completed' : 'Failed',
      message: commandMessage,
      rawPayload: {
        source: 'Fairino-Studio Electron Simulator',
        commandType: command.commandType
      },
      completedAt: new Date().toISOString()
    })

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
      lastError: error instanceof Error ? error.message : 'Command polling failed'
    })
  } finally {
    commandPollInFlight = false
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
    void pollCommand(normalizedConfig, callbacks, currentRunId)

    heartbeatTimer = setInterval(() => {
      void sendHeartbeat(normalizedConfig, callbacks, currentRunId)
    }, normalizedConfig.heartbeatIntervalMs)

    telemetryTimer = setInterval(() => {
      void sendTelemetry(normalizedConfig, callbacks, currentRunId)
    }, normalizedConfig.telemetryIntervalMs)

    commandPollTimer = setInterval(() => {
      void pollCommand(normalizedConfig, callbacks, currentRunId)
    }, normalizedConfig.commandPollIntervalMs)
  },

  stop(): void {
    runId += 1

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }

    if (telemetryTimer) {
      clearInterval(telemetryTimer)
      telemetryTimer = null
    }

    if (commandPollTimer) {
      clearInterval(commandPollTimer)
      commandPollTimer = null
    }

    heartbeatInFlight = false
    telemetryInFlight = false
    commandPollInFlight = false
    running = false
  },

  isRunning(): boolean {
    return running
  }
}
