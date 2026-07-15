import type { FactoryFailurePolicy } from '../../types/factoryProgram.types'

export type SafetyFaultType =
  | 'robot-obstacle'
  | 'robot-robot'
  | 'self-collision'
  | 'ground-collision'
  | 'connection-lost'
  | 'global-estop'

export type SafetyStopScope = 'Robot' | 'SafetyGroup' | 'All'

export type SafetyStopCause = 'root-fault' | 'safety-group' | 'execution-group' | 'global'

export interface SafetyFaultEvent {
  type: SafetyFaultType
  rootRobotIds: readonly string[]
  objectIds?: readonly string[]
  code?: string
  message?: string
  stopScope?: SafetyStopScope
  detectedAtUtc?: string
}

export interface SafetyStopResolution {
  event: SafetyFaultEvent
  rootRobotIds: string[]
  safetyGroupRobotIds: string[]
  executionGroupRobotIds: string[]
  stopRobotIds: string[]
  affectedSafetyGroupIds: string[]
  affectedExecutionGroupIds: string[]
  causeByRobotId: Record<string, SafetyStopCause>
}

export interface ExecutionGroupRegistration {
  executionGroupId: string
  robotId: string
  failurePolicy: FactoryFailurePolicy
}

export interface SafetyStopEffects {
  cancelRobot: (robotId: string, reason: string) => boolean
  latchRobotFault: (robotId: string, cause: SafetyStopCause, event: SafetyFaultEvent) => void
}

export interface SafetyStopResolverOptions {
  allRobotIds?: readonly string[]
}
