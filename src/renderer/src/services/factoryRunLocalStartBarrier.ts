import type { FactoryFailurePolicy } from '../types/factoryProgram.types'

type TimerHandle = ReturnType<typeof setTimeout>

interface FactoryRunStartWaiter {
  participantId: string
  signal: AbortSignal
  resolve: (releasedAtMonotonicMs: number) => void
  reject: (error: Error) => void
  handleAbort: () => void
}

type FactoryRunLocalStartBarrierState = 'assembling' | 'released' | 'rejected'

interface FactoryRunLocalStartBarrier {
  scheduledAtMs: number
  reportedParticipantCount: number
  expectedParticipantCount: number
  failurePolicy: FactoryFailurePolicy
  timerId: TimerHandle | null
  cleanupTimerId: TimerHandle | null
  releasedAtMs: number | null
  state: FactoryRunLocalStartBarrierState
  waiters: Map<string, FactoryRunStartWaiter>
  droppedParticipantIds: Set<string>
  unassignedDropCredits: number
}

export interface FactoryRunLocalStartBarrierDebugEvent {
  factoryRunId: string
  participantCount: number
  scheduledAtUtc: string
  releasedAtUtc: string
  releasedAtMonotonicMs: number
  absoluteLateByMs: number
  releasedAfterSoftDeadline: boolean
}

export interface FactoryRunLocalStartBarrierOptions {
  registerParticipant: (factoryRunId: string, participantId: string) => void
  sealParticipants: (factoryRunId: string) => number
  abortRun: (factoryRunId: string, reason: Error) => void
  cancelExecutionGroup: (factoryRunId: string, reason: string) => void
  nowUtcMs?: () => number
  nowMonotonicMs?: () => number
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimer?: (timerId: TimerHandle) => void
  joinTimeoutMs?: number
  isolateJoinTimeoutMs?: number
  maxAbsoluteLatenessMs?: number
  hardMaxAbsoluteLatenessMs?: number
  cleanupDelayMs?: number
  onReleased?: (event: FactoryRunLocalStartBarrierDebugEvent) => void
}

const DEFAULT_JOIN_TIMEOUT_MS = 2000
const DEFAULT_ISOLATE_JOIN_TIMEOUT_MS = 10000
const DEFAULT_MAX_ABSOLUTE_LATENESS_MS = 2000
const DEFAULT_HARD_MAX_ABSOLUTE_LATENESS_MS = 30000
const DEFAULT_CLEANUP_DELAY_MS = 5000

function positiveFiniteOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export class FactoryRunLocalStartBarrierCoordinator {
  private readonly barriers = new Map<string, FactoryRunLocalStartBarrier>()
  private readonly nowUtcMs: () => number
  private readonly nowMonotonicMs: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle
  private readonly clearTimer: (timerId: TimerHandle) => void
  private readonly joinTimeoutMs: number
  private readonly isolateJoinTimeoutMs: number
  private readonly maxAbsoluteLatenessMs: number
  private readonly hardMaxAbsoluteLatenessMs: number
  private readonly cleanupDelayMs: number

  constructor(private readonly options: FactoryRunLocalStartBarrierOptions) {
    this.nowUtcMs = options.nowUtcMs ?? (() => Date.now())
    this.nowMonotonicMs = options.nowMonotonicMs ?? (() => performance.now())
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timerId) => clearTimeout(timerId))
    this.joinTimeoutMs = positiveFiniteOrDefault(options.joinTimeoutMs, DEFAULT_JOIN_TIMEOUT_MS)
    this.maxAbsoluteLatenessMs = positiveFiniteOrDefault(
      options.maxAbsoluteLatenessMs,
      DEFAULT_MAX_ABSOLUTE_LATENESS_MS
    )
    this.hardMaxAbsoluteLatenessMs = Math.max(
      this.maxAbsoluteLatenessMs,
      positiveFiniteOrDefault(
        options.hardMaxAbsoluteLatenessMs,
        DEFAULT_HARD_MAX_ABSOLUTE_LATENESS_MS
      )
    )
    this.isolateJoinTimeoutMs = Math.min(
      this.hardMaxAbsoluteLatenessMs - 250,
      Math.max(
        this.joinTimeoutMs,
        positiveFiniteOrDefault(options.isolateJoinTimeoutMs, DEFAULT_ISOLATE_JOIN_TIMEOUT_MS)
      )
    )
    this.cleanupDelayMs = Math.max(
      this.hardMaxAbsoluteLatenessMs,
      positiveFiniteOrDefault(options.cleanupDelayMs, DEFAULT_CLEANUP_DELAY_MS)
    )
  }

  waitForStart(
    factoryRunId: string,
    participantId: string,
    scheduledStartAtUtc: string,
    expectedParticipantCount: number,
    signal: AbortSignal,
    failurePolicy: FactoryFailurePolicy = 'AbortExecutionGroup'
  ): Promise<number> {
    const normalizedFactoryRunId = factoryRunId.trim()
    const normalizedParticipantId = participantId.trim()

    if (!normalizedFactoryRunId) {
      throw new Error('Factory run ID is required for the local start barrier.')
    }

    if (!normalizedParticipantId) {
      throw new Error('Factory run local participant ID is required.')
    }

    if (!Number.isInteger(expectedParticipantCount) || expectedParticipantCount <= 0) {
      throw new Error(
        `Factory run expectedParticipantCount is invalid: ${expectedParticipantCount}.`
      )
    }

    if (failurePolicy !== 'IsolateTarget' && failurePolicy !== 'AbortExecutionGroup') {
      throw new Error(`Unsupported FactoryRun failure policy: ${failurePolicy}.`)
    }

    const scheduledAtMs = Date.parse(scheduledStartAtUtc)
    if (!Number.isFinite(scheduledAtMs)) {
      throw new Error('Factory run scheduledStartAtUtc is invalid.')
    }

    if (signal.aborted) {
      throw new Error(
        `Factory run participant ${normalizedParticipantId} was already cancelled ` +
          'before joining the synchronized local cohort.'
      )
    }

    let barrier = this.barriers.get(normalizedFactoryRunId)

    if (!barrier) {
      barrier = this.createBarrier(
        normalizedFactoryRunId,
        scheduledAtMs,
        expectedParticipantCount,
        failurePolicy
      )
    } else {
      this.assertMatchingBarrier(
        normalizedFactoryRunId,
        barrier,
        scheduledAtMs,
        expectedParticipantCount,
        failurePolicy
      )
    }

    if (barrier.state === 'released') {
      const joinedLateByMs = this.nowUtcMs() - (barrier.releasedAtMs ?? this.nowUtcMs())
      const lateJoinOutcome =
        barrier.failurePolicy === 'IsolateTarget'
          ? 'this late participant was isolated; the sealed survivors keep running.'
          : 'all active commands were stopped to prevent an incomplete step barrier.'
      const reason =
        `Factory run participant ${normalizedParticipantId} joined the local cohort ` +
        `${Math.max(0, Math.round(joinedLateByMs))} ms after it was sealed; ` +
        lateJoinOutcome

      if (barrier.failurePolicy !== 'IsolateTarget') {
        this.rejectBarrier(normalizedFactoryRunId, barrier, reason)
      }
      throw new Error(reason)
    }

    if (barrier.state === 'rejected') {
      throw new Error(`Factory run ${normalizedFactoryRunId} local cohort is already rejected.`)
    }

    if (barrier.waiters.has(normalizedParticipantId)) {
      const reason =
        `Factory run participant ${normalizedParticipantId} attempted to join ` +
        'the local cohort more than once.'

      this.rejectBarrier(normalizedFactoryRunId, barrier, reason)
      throw new Error(reason)
    }

    const activeBarrier = barrier

    return new Promise<number>((resolve, reject) => {
      const waiter: FactoryRunStartWaiter = {
        participantId: normalizedParticipantId,
        signal,
        resolve,
        reject,
        handleAbort: () => {
          if (activeBarrier.state !== 'assembling') return

          const reason =
            `Factory run participant ${normalizedParticipantId} was cancelled ` +
            'before the synchronized local cohort was released.'

          if (activeBarrier.failurePolicy === 'IsolateTarget') {
            this.dropParticipant(normalizedFactoryRunId, normalizedParticipantId, reason)
          } else {
            this.rejectBarrier(normalizedFactoryRunId, activeBarrier, reason)
          }
        }
      }

      activeBarrier.waiters.set(normalizedParticipantId, waiter)
      signal.addEventListener('abort', waiter.handleAbort, { once: true })

      if (signal.aborted) {
        waiter.handleAbort()
        return
      }

      if (
        activeBarrier.waiters.size >
        activeBarrier.expectedParticipantCount + activeBarrier.unassignedDropCredits
      ) {
        this.rejectBarrier(
          normalizedFactoryRunId,
          activeBarrier,
          `Factory run local cohort received ${activeBarrier.waiters.size} participants, ` +
            `but expected only ${activeBarrier.expectedParticipantCount}.`
        )
        return
      }

      this.scheduleReleaseWhenComplete(normalizedFactoryRunId, activeBarrier)
    })
  }

  dropParticipant(factoryRunId: string, participantId: string, reason: string): number | null {
    const normalizedFactoryRunId = factoryRunId.trim()
    const normalizedParticipantId = participantId.trim()
    const barrier = this.barriers.get(normalizedFactoryRunId)

    if (!barrier || barrier.state !== 'assembling' || !normalizedParticipantId) {
      return null
    }

    if (barrier.droppedParticipantIds.has(normalizedParticipantId)) {
      return barrier.expectedParticipantCount
    }

    barrier.droppedParticipantIds.add(normalizedParticipantId)

    if (barrier.unassignedDropCredits > 0) {
      barrier.unassignedDropCredits -= 1
    } else {
      barrier.expectedParticipantCount = Math.max(0, barrier.expectedParticipantCount - 1)
    }

    const waiter = barrier.waiters.get(normalizedParticipantId)
    if (waiter) {
      barrier.waiters.delete(normalizedParticipantId)
      waiter.signal.removeEventListener('abort', waiter.handleAbort)
      waiter.reject(new Error(reason))
    }

    if (barrier.expectedParticipantCount === 0) {
      this.clearBarrierTimer(barrier)
      this.barriers.delete(normalizedFactoryRunId)

      for (const survivor of barrier.waiters.values()) {
        survivor.signal.removeEventListener('abort', survivor.handleAbort)
        survivor.reject(new Error(reason))
      }

      barrier.waiters.clear()
      barrier.state = 'rejected'
      return 0
    }

    this.scheduleReleaseWhenComplete(normalizedFactoryRunId, barrier)
    return barrier.expectedParticipantCount
  }

  clear(reason = 'Factory session cleared.'): void {
    for (const [factoryRunId, barrier] of [...this.barriers.entries()]) {
      this.rejectBarrier(factoryRunId, barrier, reason)
    }
  }

  private createBarrier(
    factoryRunId: string,
    scheduledAtMs: number,
    expectedParticipantCount: number,
    failurePolicy: FactoryFailurePolicy
  ): FactoryRunLocalStartBarrier {
    const barrier: FactoryRunLocalStartBarrier = {
      scheduledAtMs,
      reportedParticipantCount: expectedParticipantCount,
      expectedParticipantCount,
      failurePolicy,
      timerId: null,
      cleanupTimerId: null,
      releasedAtMs: null,
      state: 'assembling',
      waiters: new Map<string, FactoryRunStartWaiter>(),
      droppedParticipantIds: new Set<string>(),
      unassignedDropCredits: 0
    }

    this.barriers.set(factoryRunId, barrier)

    const joinGraceMs =
      failurePolicy === 'IsolateTarget' ? this.isolateJoinTimeoutMs : this.joinTimeoutMs
    const joinTimeoutDelayMs = Math.max(0, scheduledAtMs - this.nowUtcMs()) + joinGraceMs

    barrier.timerId = this.setTimer(() => {
      if (barrier.state !== 'assembling') return

      if (barrier.failurePolicy === 'IsolateTarget' && barrier.waiters.size > 0) {
        const missingParticipantCount = Math.max(
          0,
          barrier.expectedParticipantCount - barrier.waiters.size
        )

        barrier.expectedParticipantCount = barrier.waiters.size
        barrier.unassignedDropCredits += missingParticipantCount

        console.warn('[FactoryRun] local cohort isolated missing participants', {
          factoryRunId,
          survivingParticipantCount: barrier.waiters.size,
          missingParticipantCount,
          joinGraceMs
        })

        this.releaseBarrier(factoryRunId, barrier)
        return
      }

      this.rejectBarrier(
        factoryRunId,
        barrier,
        `Factory run local cohort timed out with ${barrier.waiters.size}/` +
          `${barrier.expectedParticipantCount} participants; ` +
          'all active commands were stopped before sealing an incomplete step barrier.'
      )
    }, joinTimeoutDelayMs)

    return barrier
  }

  private assertMatchingBarrier(
    factoryRunId: string,
    barrier: FactoryRunLocalStartBarrier,
    scheduledAtMs: number,
    expectedParticipantCount: number,
    failurePolicy: FactoryFailurePolicy
  ): void {
    if (Math.abs(barrier.scheduledAtMs - scheduledAtMs) > 1) {
      const reason = 'Factory run targets received different synchronized start timestamps.'
      this.rejectBarrier(factoryRunId, barrier, reason)
      throw new Error(reason)
    }

    if (barrier.failurePolicy !== failurePolicy) {
      const reason = 'Factory run targets received different failure policies.'
      this.rejectBarrier(factoryRunId, barrier, reason)
      throw new Error(reason)
    }

    if (barrier.reportedParticipantCount !== expectedParticipantCount) {
      if (barrier.failurePolicy === 'IsolateTarget') {
        if (expectedParticipantCount < barrier.reportedParticipantCount) {
          const additionalReduction = Math.max(
            0,
            barrier.expectedParticipantCount - expectedParticipantCount
          )

          barrier.expectedParticipantCount -= additionalReduction
          barrier.unassignedDropCredits += additionalReduction
          barrier.reportedParticipantCount = expectedParticipantCount
        }

        return
      }

      const reason =
        'Factory run targets received different participant counts: ' +
        `${barrier.reportedParticipantCount} and ${expectedParticipantCount}.`

      this.rejectBarrier(factoryRunId, barrier, reason)
      throw new Error(reason)
    }
  }

  private scheduleReleaseWhenComplete(
    factoryRunId: string,
    barrier: FactoryRunLocalStartBarrier
  ): void {
    if (
      barrier.state !== 'assembling' ||
      barrier.waiters.size !== barrier.expectedParticipantCount
    ) {
      return
    }

    this.clearBarrierTimer(barrier)
    const releaseDelayMs = barrier.scheduledAtMs - this.nowUtcMs()

    if (releaseDelayMs <= 0) {
      this.releaseBarrier(factoryRunId, barrier)
      return
    }

    barrier.timerId = this.setTimer(
      () => this.releaseBarrier(factoryRunId, barrier),
      releaseDelayMs
    )
  }

  private releaseBarrier(factoryRunId: string, barrier: FactoryRunLocalStartBarrier): void {
    if (barrier.state !== 'assembling') return

    if (barrier.waiters.size !== barrier.expectedParticipantCount) {
      this.rejectBarrier(
        factoryRunId,
        barrier,
        `Factory run local cohort contains ${barrier.waiters.size}/` +
          `${barrier.expectedParticipantCount} expected participants; ` +
          'all active commands were stopped before sealing an incomplete step barrier.'
      )
      return
    }

    const releasedAtMs = this.nowUtcMs()
    const releasedAtMonotonicMs = this.nowMonotonicMs()
    const absoluteLateByMs = Math.max(0, releasedAtMs - barrier.scheduledAtMs)

    if (absoluteLateByMs > this.hardMaxAbsoluteLatenessMs) {
      this.rejectBarrier(
        factoryRunId,
        barrier,
        `Factory run local cohort was delayed by ${Math.round(absoluteLateByMs)} ms; ` +
          'the execution group was stopped because the shared timeline is no longer safe.'
      )
      return
    }

    const releasedAfterSoftDeadline = absoluteLateByMs > this.maxAbsoluteLatenessMs

    if (releasedAfterSoftDeadline) {
      console.warn('[FactoryRun] local cohort released after the soft start deadline', {
        factoryRunId,
        participantCount: barrier.expectedParticipantCount,
        absoluteLateByMs: Math.round(absoluteLateByMs),
        softDeadlineMs: this.maxAbsoluteLatenessMs,
        hardDeadlineMs: this.hardMaxAbsoluteLatenessMs
      })
    }

    const waiters = [...barrier.waiters.values()]

    try {
      for (const waiter of waiters) {
        this.options.registerParticipant(factoryRunId, waiter.participantId)
      }

      const sealedParticipantCount = this.options.sealParticipants(factoryRunId)
      if (sealedParticipantCount !== barrier.expectedParticipantCount) {
        throw new Error(
          `Factory run ${factoryRunId} sealed ${sealedParticipantCount} participants, ` +
            `but expected ${barrier.expectedParticipantCount}.`
        )
      }
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : `Factory run ${factoryRunId} could not seal its local participants.`

      this.rejectBarrier(factoryRunId, barrier, reason)
      return
    }

    this.clearBarrierTimer(barrier)
    barrier.state = 'released'
    barrier.releasedAtMs = releasedAtMs
    barrier.waiters.clear()

    for (const waiter of waiters) {
      waiter.signal.removeEventListener('abort', waiter.handleAbort)
      waiter.resolve(releasedAtMonotonicMs)
    }

    barrier.cleanupTimerId = this.setTimer(() => {
      if (this.barriers.get(factoryRunId) === barrier) {
        this.barriers.delete(factoryRunId)
      }
    }, this.cleanupDelayMs)

    this.options.onReleased?.({
      factoryRunId,
      participantCount: waiters.length,
      scheduledAtUtc: new Date(barrier.scheduledAtMs).toISOString(),
      releasedAtUtc: new Date(releasedAtMs).toISOString(),
      releasedAtMonotonicMs,
      absoluteLateByMs: Math.round(absoluteLateByMs),
      releasedAfterSoftDeadline
    })
  }

  private rejectBarrier(
    factoryRunId: string,
    barrier: FactoryRunLocalStartBarrier,
    reason: string
  ): void {
    if (barrier.state === 'rejected') return

    barrier.state = 'rejected'
    this.clearBarrierTimer(barrier)
    this.clearCleanupTimer(barrier)

    if (this.barriers.get(factoryRunId) === barrier) {
      this.barriers.delete(factoryRunId)
    }

    const error = new Error(reason)
    const waiters = [...barrier.waiters.values()]
    barrier.waiters.clear()

    for (const waiter of waiters) {
      waiter.signal.removeEventListener('abort', waiter.handleAbort)
    }

    this.options.abortRun(factoryRunId, error)
    this.options.cancelExecutionGroup(factoryRunId, reason)

    for (const waiter of waiters) {
      waiter.reject(error)
    }
  }

  private clearBarrierTimer(barrier: FactoryRunLocalStartBarrier): void {
    if (barrier.timerId === null) return
    this.clearTimer(barrier.timerId)
    barrier.timerId = null
  }

  private clearCleanupTimer(barrier: FactoryRunLocalStartBarrier): void {
    if (barrier.cleanupTimerId === null) return
    this.clearTimer(barrier.cleanupTimerId)
    barrier.cleanupTimerId = null
  }
}
