export interface BackendSimulatorConfig {
  enabled: boolean
  backendUrl: string
  robotId: string
  deviceSecret: string
  heartbeatIntervalMs: number
  telemetryIntervalMs: number
  commandPollIntervalMs: number
}

export interface TcpPose {
  x: number
  y: number
  z: number
  rx: number
  ry: number
  rz: number
}

export interface DeviceTelemetryPayload {
  robotId: string
  tcpPose: TcpPose
  jointAngles: number[]
  temperature: number | null
  statusCode: string
  collisionWarning: boolean
  timestamp: string
}

export interface PendingDeviceCommand {
  commandId: string
  robotId: string
  commandType: string
  payload?: unknown
  createdAt: string
}

export interface DeviceCommandResultPayload {
  commandId: string
  robotId: string
  success: boolean
  status: 'Completed' | 'Failed'
  message: string
  rawPayload?: unknown
  completedAt: string
}

export interface BackendSimulatorStatus {
  isRunning: boolean
  isConnected: boolean
  lastHeartbeatAt?: string
  lastTelemetryAt?: string
  lastCommandAt?: string
  lastResultAt?: string
  lastError?: string
}

export const defaultBackendSimulatorConfig: BackendSimulatorConfig = {
  enabled: false,
  backendUrl: 'http://localhost:5200',
  robotId: '',
  deviceSecret: '',
  heartbeatIntervalMs: 3000,
  telemetryIntervalMs: 250,
  commandPollIntervalMs: 1000
}
