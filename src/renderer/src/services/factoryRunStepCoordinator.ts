export interface FactoryRunStepBarrierResult {
  stepIndex: number
  participantCount: number
  completionSkewMs: number
  nextStepStartedAtMonotonicMs: number
}

export interface FactoryRunStepArrival {
  factoryRunId: string
  participantId: string
  stepIndex: number
  completedAtMonotonicMs: number
  signal?: AbortSignal
}

export interface FactoryRunStepCoordinatorOptions {
  maxCompletionSkewMs?: number
  barrierTimeoutMs?: number
  now?: () => number
}

interface StepWaiter {
  participantId: string
  signal?: AbortSignal
  handleAbort?: () => void
  resolve: (result: FactoryRunStepBarrierResult) => void
  reject: (error: Error) => void
}

interface StepBarrierState {
  stepIndex: number
  arrivals: Map<string, number>
  waiters: Map<string, StepWaiter>
  timeoutId: ReturnType<typeof globalThis.setTimeout>
}

interface FactoryRunCoordinatorState {
  participantIds: Set<string>
  sealedParticipantIds: Set<string> | null
  completedParticipantIds: Set<string>
  nextStepIndex: number
  stepBarrier: StepBarrierState | null
}

export class FactoryRunCoordinatorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FactoryRunCoordinatorError'
  }
}

export class FactoryRunStepSkewError extends FactoryRunCoordinatorError {
  readonly factoryRunId: string
  readonly stepIndex: number
  readonly completionSkewMs: number

  constructor(factoryRunId: string, stepIndex: number, completionSkewMs: number) {
    super(
      `Factory run ${factoryRunId} step ${stepIndex + 1} has an inter-robot ` +
        `completion skew of ${Math.round(completionSkewMs)} ms.`
    )

    this.name = 'FactoryRunStepSkewError'
    this.factoryRunId = factoryRunId
    this.stepIndex = stepIndex
    this.completionSkewMs = completionSkewMs
  }
}

export class FactoryRunStepTimeoutError extends FactoryRunCoordinatorError {
  constructor(factoryRunId: string, stepIndex: number, timeoutMs: number) {
    super(
      `Factory run ${factoryRunId} step ${stepIndex + 1} did not receive every ` +
        `participant within ${timeoutMs} ms.`
    )

    this.name = 'FactoryRunStepTimeoutError'
  }
}

export class FactoryRunStepCoordinator {
  private readonly runs = new Map<string, FactoryRunCoordinatorState>()
  private readonly maxCompletionSkewMs: number
  private readonly barrierTimeoutMs: number
  private readonly now: () => number

  constructor(options: FactoryRunStepCoordinatorOptions = {}) {
    this.maxCompletionSkewMs = options.maxCompletionSkewMs ?? 50
    this.barrierTimeoutMs = options.barrierTimeoutMs ?? 2000
    this.now = options.now ?? (() => performance.now())

    if (this.maxCompletionSkewMs < 0) {
      throw new Error('maxCompletionSkewMs must be greater than or equal to zero.')
    }

    if (this.barrierTimeoutMs <= 0) {
      throw new Error('barrierTimeoutMs must be greater than zero.')
    }
  }

  registerParticipant(factoryRunId: string, participantId: string): void {
    const normalizedRunId = factoryRunId.trim()
    const normalizedParticipantId = participantId.trim()

    if (!normalizedRunId) {
      throw new FactoryRunCoordinatorError('Factory run ID is required.')
    }

    if (!normalizedParticipantId) {
      throw new FactoryRunCoordinatorError('Factory run participant ID is required.')
    }

    let run = this.runs.get(normalizedRunId)

    if (!run) {
      run = {
        participantIds: new Set<string>(),
        sealedParticipantIds: null,
        completedParticipantIds: new Set<string>(),
        nextStepIndex: 0,
        stepBarrier: null
      }

      this.runs.set(normalizedRunId, run)
    }

    if (run.sealedParticipantIds) {
      if (run.sealedParticipantIds.has(normalizedParticipantId)) {
        return
      }

      throw new FactoryRunCoordinatorError(
        `Factory run ${normalizedRunId} cannot accept participant ` +
          `${normalizedParticipantId} after the cohort was sealed.`
      )
    }

    run.participantIds.add(normalizedParticipantId)
  }

  sealParticipants(factoryRunId: string): number {
    const run = this.getRun(factoryRunId)

    if (run.sealedParticipantIds) {
      return run.sealedParticipantIds.size
    }

    if (run.participantIds.size === 0) {
      throw new FactoryRunCoordinatorError(
        `Factory run ${factoryRunId} has no registered participants.`
      )
    }

    run.sealedParticipantIds = new Set(run.participantIds)
    return run.sealedParticipantIds.size
  }

  arriveAtStep(arrival: FactoryRunStepArrival): Promise<FactoryRunStepBarrierResult> {
    const run = this.getRun(arrival.factoryRunId)
    const participantIds = run.sealedParticipantIds
    const participantId = arrival.participantId.trim()

    if (!participantIds) {
      throw new FactoryRunCoordinatorError(
        `Factory run ${arrival.factoryRunId} must seal its participants before step execution.`
      )
    }

    if (!participantIds.has(participantId)) {
      throw new FactoryRunCoordinatorError(
        `Participant ${participantId} is not part of factory run ${arrival.factoryRunId}.`
      )
    }

    if (arrival.stepIndex !== run.nextStepIndex) {
      throw new FactoryRunCoordinatorError(
        `Factory run ${arrival.factoryRunId} expected step ${run.nextStepIndex + 1}, ` +
          `but participant ${participantId} arrived at step ${arrival.stepIndex + 1}.`
      )
    }

    if (!Number.isFinite(arrival.completedAtMonotonicMs)) {
      throw new FactoryRunCoordinatorError(
        'completedAtMonotonicMs must be a finite monotonic timestamp.'
      )
    }

    if (arrival.signal?.aborted) {
      throw new FactoryRunCoordinatorError(
        `Participant ${participantId} was cancelled before reaching the step barrier.`
      )
    }

    const barrier =
      run.stepBarrier ?? this.createStepBarrier(arrival.factoryRunId, run, arrival.stepIndex)

    if (barrier.stepIndex !== arrival.stepIndex) {
      throw new FactoryRunCoordinatorError(
        `Factory run ${arrival.factoryRunId} already has an active barrier for ` +
          `step ${barrier.stepIndex + 1}.`
      )
    }

    if (barrier.arrivals.has(participantId)) {
      throw new FactoryRunCoordinatorError(
        `Participant ${participantId} arrived more than once at ` + `step ${arrival.stepIndex + 1}.`
      )
    }

    const promise = new Promise<FactoryRunStepBarrierResult>((resolve, reject) => {
      const waiter: StepWaiter = {
        participantId,
        signal: arrival.signal,
        resolve,
        reject
      }

      if (arrival.signal) {
        waiter.handleAbort = () => {
          if (barrier.waiters.get(participantId) !== waiter) return

          barrier.waiters.delete(participantId)
          barrier.arrivals.delete(participantId)
          this.removeAbortListener(waiter)
          waiter.reject(
            new FactoryRunCoordinatorError(
              `Participant ${participantId} was cancelled while waiting at ` +
                `step ${arrival.stepIndex + 1}.`
            )
          )
        }

        arrival.signal.addEventListener('abort', waiter.handleAbort, { once: true })
      }

      barrier.waiters.set(participantId, waiter)
      barrier.arrivals.set(participantId, arrival.completedAtMonotonicMs)
    })

    if (barrier.arrivals.size === participantIds.size) {
      this.releaseStepBarrier(arrival.factoryRunId, run, barrier)
    }

    return promise
  }

  dropParticipant(factoryRunId: string, participantId: string, reason: Error): number {
    const normalizedRunId = factoryRunId.trim()
    const normalizedParticipantId = participantId.trim()
    const run = this.runs.get(normalizedRunId)

    if (!run || !normalizedParticipantId) {
      return 0
    }

    const activeParticipantIds = run.sealedParticipantIds ?? run.participantIds

    if (!activeParticipantIds.delete(normalizedParticipantId)) {
      return activeParticipantIds.size
    }

    run.participantIds.delete(normalizedParticipantId)
    run.completedParticipantIds.delete(normalizedParticipantId)

    const barrier = run.stepBarrier
    if (barrier) {
      const waiter = barrier.waiters.get(normalizedParticipantId)

      if (waiter) {
        this.removeAbortListener(waiter)
        barrier.waiters.delete(normalizedParticipantId)
        waiter.reject(reason)
      }

      barrier.arrivals.delete(normalizedParticipantId)
    }

    if (activeParticipantIds.size === 0) {
      if (barrier) {
        this.rejectStepBarrier(barrier, reason)
      }

      this.runs.delete(normalizedRunId)
      return 0
    }

    if (barrier && barrier.arrivals.size === activeParticipantIds.size) {
      this.releaseStepBarrier(normalizedRunId, run, barrier)
    }

    return activeParticipantIds.size
  }

  abortRun(factoryRunId: string, reason: Error): void {
    const run = this.runs.get(factoryRunId)

    if (!run) {
      return
    }

    if (run.stepBarrier) {
      this.rejectStepBarrier(run.stepBarrier, reason)
      run.stepBarrier = null
    }

    this.runs.delete(factoryRunId)
  }

  completeParticipant(factoryRunId: string, participantId: string): void {
    const run = this.runs.get(factoryRunId)

    if (!run) {
      return
    }

    const normalizedParticipantId = participantId.trim()
    const activeParticipantIds = run.sealedParticipantIds ?? run.participantIds

    if (!activeParticipantIds.has(normalizedParticipantId)) {
      return
    }

    run.completedParticipantIds.add(normalizedParticipantId)

    if (run.completedParticipantIds.size < activeParticipantIds.size) {
      return
    }

    if (run.stepBarrier) {
      this.rejectStepBarrier(
        run.stepBarrier,
        new FactoryRunCoordinatorError(
          `Factory run ${factoryRunId} completed while a step barrier was still active.`
        )
      )
    }

    this.runs.delete(factoryRunId)
  }

  clear(reason = new FactoryRunCoordinatorError('Factory session cleared.')): void {
    for (const factoryRunId of [...this.runs.keys()]) {
      this.abortRun(factoryRunId, reason)
    }
  }

  private getRun(factoryRunId: string): FactoryRunCoordinatorState {
    const run = this.runs.get(factoryRunId)

    if (!run) {
      throw new FactoryRunCoordinatorError(
        `Factory run ${factoryRunId} has not registered any participants.`
      )
    }

    return run
  }

  private createStepBarrier(
    factoryRunId: string,
    run: FactoryRunCoordinatorState,
    stepIndex: number
  ): StepBarrierState {
    const barrier: StepBarrierState = {
      stepIndex,
      arrivals: new Map<string, number>(),
      waiters: new Map<string, StepWaiter>(),
      timeoutId: globalThis.setTimeout(() => {
        this.abortRun(
          factoryRunId,
          new FactoryRunStepTimeoutError(factoryRunId, stepIndex, this.barrierTimeoutMs)
        )
      }, this.barrierTimeoutMs)
    }

    run.stepBarrier = barrier
    return barrier
  }

  private releaseStepBarrier(
    factoryRunId: string,
    run: FactoryRunCoordinatorState,
    barrier: StepBarrierState
  ): void {
    const completionTimes = [...barrier.arrivals.values()]
    const earliestCompletion = Math.min(...completionTimes)
    const latestCompletion = Math.max(...completionTimes)
    const completionSkewMs = latestCompletion - earliestCompletion

    if (completionSkewMs > this.maxCompletionSkewMs) {
      this.abortRun(
        factoryRunId,
        new FactoryRunStepSkewError(factoryRunId, barrier.stepIndex, completionSkewMs)
      )
      return
    }

    globalThis.clearTimeout(barrier.timeoutId)

    const result: FactoryRunStepBarrierResult = {
      stepIndex: barrier.stepIndex,
      participantCount: completionTimes.length,
      completionSkewMs,
      nextStepStartedAtMonotonicMs: this.now()
    }

    run.stepBarrier = null
    run.nextStepIndex += 1

    for (const waiter of barrier.waiters.values()) {
      this.removeAbortListener(waiter)
      waiter.resolve(result)
    }

    barrier.waiters.clear()
    barrier.arrivals.clear()
  }

  private rejectStepBarrier(barrier: StepBarrierState, error: Error): void {
    globalThis.clearTimeout(barrier.timeoutId)

    for (const waiter of barrier.waiters.values()) {
      this.removeAbortListener(waiter)
      waiter.reject(error)
    }

    barrier.waiters.clear()
    barrier.arrivals.clear()
  }

  private removeAbortListener(waiter: StepWaiter): void {
    if (waiter.signal && waiter.handleAbort) {
      waiter.signal.removeEventListener('abort', waiter.handleAbort)
    }
  }
}

export const factoryRunStepCoordinator = new FactoryRunStepCoordinator()
