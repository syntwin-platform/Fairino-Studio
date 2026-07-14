import type {
  BackendLuaDiagnostic,
  BackendLuaPreviewResponse
} from '../services/backendLuaImportClient'
import type { WorkflowStep } from './robot.types'

export type FactoryProgramScope = 'single' | 'batch'
export type FactoryCoordinationMode = 'ParallelIndependent' | 'Synchronized'

export type FactoryFailurePolicy = 'IsolateTarget' | 'AbortExecutionGroup'

export type FactoryRunTargetTerminationReason =
  | 'CommandFailure'
  | 'Collision'
  | 'ConnectionLost'
  | 'Timeout'
  | 'SafetyPolicy'
  | 'GroupPolicy'
  | 'UserCancelled'

export const DEFAULT_FACTORY_COORDINATION_MODE: FactoryCoordinationMode = 'Synchronized'

export const DEFAULT_FACTORY_FAILURE_POLICY: FactoryFailurePolicy = 'IsolateTarget'

export type FactoryRobotProgramStatus =
  | 'idle'
  | 'checking'
  | 'not-ready'
  | 'ready'
  | 'preparing'
  | 'prepared'
  | 'waiting-ready'
  | 'waiting-start'
  | 'armed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type FactoryRunStatus =
  | 'idle'
  | 'validating'
  | 'created'
  | 'preparing'
  | 'waiting-ready'
  | 'ready'
  | 'starting'
  | 'running'
  | 'running-degraded'
  | 'completed'
  | 'partially-completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'

export interface ValidatedLuaProgram {
  fileName: string
  luaContent: string
  projectName: string
  steps: WorkflowStep[]
  diagnostics: BackendLuaDiagnostic[]
  raw: BackendLuaPreviewResponse
}

export interface FactoryRobotProgramState {
  robotId: string
  selected: boolean
  status: FactoryRobotProgramStatus
  readinessErrors: string[]
  programId?: string
  prepareCommandId?: string
  commandId?: string
  message?: string
  startedAt?: string
  completedAt?: string
}

export interface FactoryRunMetadata {
  factoryRunId: string | null
  coordinationMode: FactoryCoordinationMode
  failurePolicy: FactoryFailurePolicy
  scheduledStartAtUtc: string | null
  actualStartSkewMs: number | null
  maxStartShiftMs: number | null
  status: FactoryRunStatus
  error: string | null
}
