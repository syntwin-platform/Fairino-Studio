export interface BackendSimulatorConfig {
  enabled: boolean
  backendUrl: string
  robotId: string
  deviceSecret: string
  heartbeatIntervalMs: number
  telemetryIntervalMs: number
  commandPollIntervalMs: number
}

export interface DeviceSessionResponse {
  robotId: string
  runtimeSessionId?: string | null
  accessToken: string
  expiresInSeconds: number
}

export interface BackendRuntimeScaleConfig {
  allowLegacyDeviceSecretAuth?: boolean
  pendingCommandPollIntervalMilliseconds?: number
  pendingCommandMaxWaitSeconds?: number
  pendingCommandMaxSkippedQueueItems?: number
}

export interface MoveLMotionPolicy {
  maxDistanceMm: number
  maxRotationDeg: number
  waypointSpacingMm: number
  timeoutMs: number
}

export interface MoveJMotionPolicy {
  timeoutMs: number
  maxJointDeltaDeg: number
}

export interface RobotMotionPolicy {
  moveL: MoveLMotionPolicy
  moveJ: MoveJMotionPolicy
}

export interface JointLimit {
  joint: number
  minDeg: number
  maxDeg: number
}

export interface RobotRuntimeConfig {
  robotId: string
  robotModel: string
  profile: string
  motionPolicy: RobotMotionPolicy
  jointLimits: JointLimit[]
}

export interface TcpPose {
  x: number
  y: number
  z: number
  rx: number
  ry: number
  rz: number
}

export interface DeviceIoSnapshot {
  cabinetDigitalOutputs: Record<number, boolean>
  toolDigitalOutputs: Record<number, boolean>
  gripperState: 'open' | 'closed'
}

export interface DeviceExecutionSnapshot {
  currentCommandId?: string
  state: 'Idle' | 'Running' | 'Failed'
  currentStepIndex?: number
  totalSteps?: number
  progressPercent?: number
  startedAt?: string
  lastError?: string
}

export interface DeviceTelemetryPayload {
  robotId: string
  tcpPose: TcpPose
  jointAngles: number[]
  sequenceNumber?: number
  io?: DeviceIoSnapshot
  execution?: DeviceExecutionSnapshot
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
  status: 'Completed' | 'Failed' | 'Cancelled'
  message: string
  rawPayload?: unknown
  completedAt: string
}

export interface TelemetryRuntimeSample {
  recordedAt: string
  roundTripMs: number
  sequenceNumber?: number
}

export interface BackendSimulatorStatus {
  isRunning: boolean
  isConnected: boolean
  lastHeartbeatAt?: string
  lastTelemetryAt?: string
  lastTelemetrySequenceNumber?: number
  lastTelemetryRoundTripMs?: number
  lastTelemetryStatusCode?: string
  lastCollisionWarning?: boolean
  lastIoSnapshot?: DeviceIoSnapshot
  lastExecutionSnapshot?: DeviceExecutionSnapshot
  telemetrySamples?: TelemetryRuntimeSample[]
  lastCommandAt?: string
  lastResultAt?: string
  lastError?: string
}

export type BackendSimulatorConfigByRobotId = Record<string, BackendSimulatorConfig>

export type BackendSimulatorStatusByRobotId = Record<string, BackendSimulatorStatus>

export function createBackendSimulatorConfigForRobot(
  baseConfig: BackendSimulatorConfig,
  robotId: string,
  deviceSecret: string
): BackendSimulatorConfig {
  return {
    ...baseConfig,
    robotId,
    deviceSecret,
    enabled: Boolean(robotId.trim() && deviceSecret.trim())
  }
}

export function createDisconnectedBackendSimulatorStatus(): BackendSimulatorStatus {
  return {
    isRunning: false,
    isConnected: false
  }
}

export const defaultRobotRuntimeConfig: RobotRuntimeConfig = {
  robotId: '',
  robotModel: 'Fairino FR5',
  profile: 'Simulator',
  motionPolicy: {
    moveL: {
      maxDistanceMm: 800,
      maxRotationDeg: 180,
      waypointSpacingMm: 5,
      timeoutMs: 20_000
    },
    moveJ: {
      timeoutMs: 20_000,
      maxJointDeltaDeg: 180
    }
  },
  jointLimits: [
    { joint: 1, minDeg: -175, maxDeg: 175 },
    { joint: 2, minDeg: -265, maxDeg: 85 },
    { joint: 3, minDeg: -160, maxDeg: 160 },
    { joint: 4, minDeg: -265, maxDeg: 265 },
    { joint: 5, minDeg: -175, maxDeg: 175 },
    { joint: 6, minDeg: -175, maxDeg: 175 }
  ]
}

export const LOCAL_BACKEND_URL = 'http://localhost:5200'
export const CLOUD_STAGING_BACKEND_URL = 'https://syntwin-api-staging-v7emjerksa-as.a.run.app'

export const BACKEND_ENVIRONMENT_OPTIONS = [
  {
    label: 'Local Backend',
    url: LOCAL_BACKEND_URL
  },
  {
    label: 'Cloud Staging Backend',
    url: CLOUD_STAGING_BACKEND_URL
  }
] as const

export const defaultBackendSimulatorConfig: BackendSimulatorConfig = {
  enabled: false,
  backendUrl: LOCAL_BACKEND_URL,
  robotId: '',
  deviceSecret: '',
  heartbeatIntervalMs: 3000,
  telemetryIntervalMs: 1000,
  commandPollIntervalMs: 1000
}

// ─── Safety Policy ────────────────────────────────────────────────────────────

export type SafetyPolicySource = 'Robot' | 'Company' | 'Default'

export type SafetySeverity = 'Info' | 'Warning' | 'Blocker'

export interface RobotJointLimit {
  joint: number
  minDeg: number
  maxDeg: number
}

export interface RobotTcpWorkspaceLimit {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
  minRotationDeg: number
  maxRotationDeg: number
}

export interface RobotSafetyPolicyDefinition {
  name: string
  robotModel: string
  jointLimits: RobotJointLimit[]
  tcpWorkspace: RobotTcpWorkspaceLimit
  minSpeedPercent: number
  maxSpeedPercent: number
  minAccelerationPercent: number
  maxAccelerationPercent: number
  maxJointDeltaDegPerStep: number
  maxFirstStepJointDeltaDeg: number
}

export interface SafetyPolicyResponse {
  source: SafetyPolicySource
  policyId: string | null
  companyId: string
  robotId: string | null
  canManage: boolean
  policy: RobotSafetyPolicyDefinition
  updatedAt: string | null
}

export interface UpsertSafetyPolicyRequest {
  policy: RobotSafetyPolicyDefinition
}

export interface SafetyDiagnostic {
  severity: SafetySeverity
  code: string
  stepOrderIndex: number | null
  stepLabel: string | null
  field: string | null
  message: string
}

export interface SafetyValidationErrorResponse {
  message: string
  diagnostics: SafetyDiagnostic[]
}
