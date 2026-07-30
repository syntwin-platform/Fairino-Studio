import type { BackendCommandResponse } from './backendProgramClient'
import type { RobotTelemetryHistoryPoint } from './backendTelemetryHistoryClient'
import type { BackendSimulatorStatus } from '../types/backendDevice'

export type RobotActivityKind = 'command' | 'telemetry' | 'heartbeat' | 'result'
export type RobotActivitySource = 'cloud' | 'session'

export interface RobotActivityEvent {
  id: string
  kind: RobotActivityKind
  source: RobotActivitySource
  timestamp: string
  label?: string
  status?: string | null
  detail?: string | null
  sequenceNumber?: number | null
  latencyMilliseconds?: number | null
  collisionWarning?: boolean | null
}

interface BuildRobotActivityEventsInput {
  commands: BackendCommandResponse[]
  telemetry: RobotTelemetryHistoryPoint[]
  runtime?: BackendSimulatorStatus
  limit?: number
}

function timestampValue(value: string): number {
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

export function buildRobotActivityEvents({
  commands,
  telemetry,
  runtime,
  limit = 80
}: BuildRobotActivityEventsInput): RobotActivityEvent[] {
  const commandEvents = commands.map<RobotActivityEvent>((command) => ({
    id: `cloud-command-${command.id}`,
    kind: 'command',
    source: 'cloud',
    timestamp: command.completedAt || command.createdAt,
    label: command.commandType,
    status: command.status,
    detail: command.failureReason || command.result?.message || null
  }))

  const telemetryEvents = telemetry.map<RobotActivityEvent>((point, index) => ({
    id: `cloud-telemetry-${point.timestamp}-${point.sequenceNumber ?? index}`,
    kind: 'telemetry',
    source: 'cloud',
    timestamp: point.timestamp,
    status: point.status,
    detail: point.source,
    sequenceNumber: point.sequenceNumber,
    latencyMilliseconds: point.latencyMilliseconds,
    collisionWarning: point.collisionWarning
  }))

  const sessionEvents: RobotActivityEvent[] = []

  if (runtime?.lastHeartbeatAt) {
    sessionEvents.push({
      id: `session-heartbeat-${runtime.lastHeartbeatAt}`,
      kind: 'heartbeat',
      source: 'session',
      timestamp: runtime.lastHeartbeatAt
    })
  }

  if (runtime?.lastTelemetryAt) {
    sessionEvents.push({
      id: `session-telemetry-${runtime.lastTelemetryAt}`,
      kind: 'telemetry',
      source: 'session',
      timestamp: runtime.lastTelemetryAt,
      status: runtime.lastTelemetryStatusCode,
      sequenceNumber: runtime.lastTelemetrySequenceNumber,
      latencyMilliseconds: runtime.lastTelemetryRoundTripMs,
      collisionWarning: runtime.lastCollisionWarning
    })
  }

  if (runtime?.lastCommandAt) {
    sessionEvents.push({
      id: `session-command-${runtime.lastCommandAt}`,
      kind: 'command',
      source: 'session',
      timestamp: runtime.lastCommandAt
    })
  }

  if (runtime?.lastResultAt) {
    sessionEvents.push({
      id: `session-result-${runtime.lastResultAt}`,
      kind: 'result',
      source: 'session',
      timestamp: runtime.lastResultAt
    })
  }

  return [...commandEvents, ...telemetryEvents, ...sessionEvents]
    .sort((left, right) => timestampValue(right.timestamp) - timestampValue(left.timestamp))
    .slice(0, Math.max(0, limit))
}
