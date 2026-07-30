export type FactoryRunDiagnosticEventName =
  | 'lua.selected'
  | 'lua.parse.started'
  | 'lua.parse.completed'
  | 'lua.parse.failed'
  | 'lua.accepted'
  | 'runtime-policy.started'
  | 'runtime-policy.completed'
  | 'runtime-policy.failed'
  | 'factory.create.started'
  | 'factory.create.completed'
  | 'factory.prepare.started'
  | 'factory.prepare.completed'
  | 'factory.ready'
  | 'factory.start-request.started'
  | 'factory.start-request.completed'
  | 'factory.completed'
  | 'factory.failed'
  | 'factory.cancelled'
  | 'robot.prepare.started'
  | 'robot.prepare.completed'
  | 'robot.prepare.failed'
  | 'robot.arm.register'
  | 'robot.arm.retry'
  | 'robot.arm.poll'
  | 'robot.cohort.joined'
  | 'robot.cohort.released'
  | 'robot.independent.ready'
  | 'robot.run.started'
  | 'robot.step.started'
  | 'robot.step.completed'
  | 'robot.motion.first-frame'
  | 'robot.run.completed'
  | 'robot.participant.dropped'
  | 'robot.run.failed'

type DiagnosticValue = string | number | boolean | null

export interface FactoryRunDiagnosticEvent {
  sessionId: string
  factoryRunId: string | null
  name: FactoryRunDiagnosticEventName
  atUtc: string
  atMonotonicMs: number
  robotId?: string
  targetId?: string
  stepIndex?: number
  durationMs?: number
  details?: Record<string, DiagnosticValue>
}

export interface FactoryRunDiagnosticSummary {
  eventCount: number
  currentStage: FactoryRunDiagnosticEventName | null
  totalElapsedMs: number
  luaParseMs: number | null
  runtimePolicyMs: number | null
  factoryCreateMs: number | null
  factoryPrepareMs: number | null
  factoryStartRequestMs: number | null
  maxRobotPreparationMs: number | null
  maxArmPollMs: number | null
}

export interface FactoryRunDiagnosticSnapshot {
  sessionId: string | null
  factoryRunId: string | null
  fileName: string | null
  active: boolean
  summary: FactoryRunDiagnosticSummary
  events: readonly FactoryRunDiagnosticEvent[]
}

interface DiagnosticSession {
  id: string
  fileName: string
  factoryRunId: string | null
  startedAtMonotonicMs: number
  active: boolean
}

interface RecordFactoryRunDiagnosticOptions {
  factoryRunId?: string | null
  robotId?: string
  targetId?: string
  stepIndex?: number
  durationMs?: number
  details?: Record<string, DiagnosticValue>
}

const MAX_DIAGNOSTIC_EVENTS = 500
const DIAGNOSTIC_UI_PUBLISH_INTERVAL_MS = 50

export function getFactoryRunMonotonicTimeMs(): number {
  return performance.now()
}

const EMPTY_SUMMARY: FactoryRunDiagnosticSummary = {
  eventCount: 0,
  currentStage: null,
  totalElapsedMs: 0,
  luaParseMs: null,
  runtimePolicyMs: null,
  factoryCreateMs: null,
  factoryPrepareMs: null,
  factoryStartRequestMs: null,
  maxRobotPreparationMs: null,
  maxArmPollMs: null
}

let activeSession: DiagnosticSession | null = null
let events: FactoryRunDiagnosticEvent[] = []
let snapshot: FactoryRunDiagnosticSnapshot = {
  sessionId: null,
  factoryRunId: null,
  fileName: null,
  active: false,
  summary: EMPTY_SUMMARY,
  events: []
}

const listeners = new Set<() => void>()
let publishTimer: ReturnType<typeof setTimeout> | null = null

const debugEnabled =
  typeof window !== 'undefined' &&
  window.localStorage.getItem('syntwin.factoryRun.debug') === 'true'

function createSessionId(): string {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2)

  return `${Date.now()}-${randomPart}`
}

function latestDuration(eventName: FactoryRunDiagnosticEventName): number | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]

    if (
      event.name === eventName &&
      typeof event.durationMs === 'number' &&
      Number.isFinite(event.durationMs)
    ) {
      return event.durationMs
    }
  }

  return null
}

function maxDuration(eventName: FactoryRunDiagnosticEventName): number | null {
  const durations = events
    .filter(
      (event) =>
        event.name === eventName &&
        typeof event.durationMs === 'number' &&
        Number.isFinite(event.durationMs)
    )
    .map((event) => event.durationMs as number)

  return durations.length > 0 ? Math.max(...durations) : null
}

function buildSummary(): FactoryRunDiagnosticSummary {
  const lastEvent = events[events.length - 1]

  return {
    eventCount: events.length,
    currentStage: lastEvent?.name ?? null,
    totalElapsedMs:
      activeSession && lastEvent
        ? Math.max(0, lastEvent.atMonotonicMs - activeSession.startedAtMonotonicMs)
        : 0,
    luaParseMs: latestDuration('lua.parse.completed'),
    runtimePolicyMs: latestDuration('runtime-policy.completed'),
    factoryCreateMs: latestDuration('factory.create.completed'),
    factoryPrepareMs: latestDuration('factory.prepare.completed'),
    factoryStartRequestMs: latestDuration('factory.start-request.completed'),
    maxRobotPreparationMs: maxDuration('robot.prepare.completed'),
    maxArmPollMs: maxDuration('robot.arm.poll')
  }
}

function publish(): void {
  snapshot = {
    sessionId: activeSession?.id ?? null,
    factoryRunId: activeSession?.factoryRunId ?? null,
    fileName: activeSession?.fileName ?? null,
    active: activeSession?.active ?? false,
    summary: buildSummary(),
    events: [...events]
  }

  for (const listener of listeners) {
    listener()
  }
}

function schedulePublish(): void {
  if (publishTimer !== null) return

  publishTimer = setTimeout(() => {
    publishTimer = null
    publish()
  }, DIAGNOSTIC_UI_PUBLISH_INTERVAL_MS)
}

function cancelScheduledPublish(): void {
  if (publishTimer === null) return
  clearTimeout(publishTimer)
  publishTimer = null
}

export function beginFactoryRunDiagnosticSession(fileName: string): string {
  cancelScheduledPublish()

  activeSession = {
    id: createSessionId(),
    fileName,
    factoryRunId: null,
    startedAtMonotonicMs: getFactoryRunMonotonicTimeMs(),
    active: true
  }

  events = []
  publish()

  recordFactoryRunDiagnostic('lua.selected', {
    details: {
      fileName
    }
  })

  return activeSession.id
}

export function attachFactoryRunDiagnosticId(factoryRunId: string): void {
  if (!activeSession?.active) return

  const normalizedFactoryRunId = factoryRunId.trim()
  if (!normalizedFactoryRunId) return

  activeSession = {
    ...activeSession,
    factoryRunId: normalizedFactoryRunId
  }

  schedulePublish()
}

export function recordFactoryRunDiagnostic(
  name: FactoryRunDiagnosticEventName,
  options: RecordFactoryRunDiagnosticOptions = {}
): void {
  if (!activeSession?.active) return

  const event: FactoryRunDiagnosticEvent = {
    sessionId: activeSession.id,
    factoryRunId: options.factoryRunId ?? activeSession.factoryRunId ?? null,
    name,
    atUtc: new Date().toISOString(),
    atMonotonicMs: getFactoryRunMonotonicTimeMs(),
    ...(options.robotId ? { robotId: options.robotId } : {}),
    ...(options.targetId ? { targetId: options.targetId } : {}),
    ...(typeof options.stepIndex === 'number' ? { stepIndex: options.stepIndex } : {}),
    ...(typeof options.durationMs === 'number'
      ? { durationMs: Math.max(0, options.durationMs) }
      : {}),
    ...(options.details ? { details: options.details } : {})
  }

  events.push(event)

  if (events.length > MAX_DIAGNOSTIC_EVENTS) {
    events.splice(0, events.length - MAX_DIAGNOSTIC_EVENTS)
  }

  if (debugEnabled) {
    console.debug('[FactoryRunDiagnostics]', event)
  }

  schedulePublish()
}

export function endFactoryRunDiagnosticSession(): void {
  if (!activeSession) return

  cancelScheduledPublish()

  activeSession = {
    ...activeSession,
    active: false
  }

  publish()
}

export function clearFactoryRunDiagnostics(): void {
  cancelScheduledPublish()
  activeSession = null
  events = []
  publish()
}

export function isFactoryRunDiagnosticSessionActive(): boolean {
  return activeSession?.active === true
}

export function getFactoryRunDiagnosticSnapshot(): FactoryRunDiagnosticSnapshot {
  return snapshot
}

export function subscribeFactoryRunDiagnostics(listener: () => void): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}
