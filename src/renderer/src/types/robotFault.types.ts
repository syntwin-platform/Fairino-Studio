export type RobotFaultKind =
  | 'collision'
  | 'command'
  | 'connection'
  | 'timeout'
  | 'safety-policy'
  | 'unknown'

export type RobotSafetyContactLevel = 'proximity' | 'collision'

export type RobotSafetyContactKind = 'ground' | 'self' | 'obstacle' | 'robot' | 'unknown'

export interface RobotFaultState {
  robotId: string
  active: true
  latched: true
  kind: RobotFaultKind
  code: string
  message: string
  detectedAtUtc: string
  updatedAtUtc: string
}

export interface RobotSafetyContactState {
  robotId: string
  level: RobotSafetyContactLevel
  kind: RobotSafetyContactKind
  counterpartRobotIds: string[]
  objectIds: string[]
  message: string | null
  detectedAtUtc: string
  updatedAtUtc: string
}

export interface RobotSafetyContactObservation {
  level: RobotSafetyContactLevel
  kind: RobotSafetyContactKind
  counterpartRobotIds?: readonly string[]
  objectIds?: readonly string[]
  message?: string | null
}

export interface LatchRobotFaultInput {
  kind: RobotFaultKind
  code: string
  message: string
  cancelMotion?: boolean
}

export interface ResetRobotFaultOptions {
  safetyValidated: boolean
}
