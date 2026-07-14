import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FactoryRunLocalStartBarrierCoordinator } from './factoryRunLocalStartBarrier'

const BASE_TIME_MS = Date.parse('2026-07-12T04:00:00.000Z')

function scheduledAt(offsetMs: number): string {
  return new Date(BASE_TIME_MS + offsetMs).toISOString()
}

function createHarness(): {
  coordinator: FactoryRunLocalStartBarrierCoordinator
  abortRun: ReturnType<typeof vi.fn>
  cancelAllActiveCommands: ReturnType<typeof vi.fn>
  registeredParticipants: Set<string>
  released: ReturnType<typeof vi.fn>
} {
  const registeredParticipants = new Set<string>()
  const abortRun = vi.fn()
  const cancelAllActiveCommands = vi.fn()
  const released = vi.fn()

  const coordinator = new FactoryRunLocalStartBarrierCoordinator({
    registerParticipant: (_factoryRunId, participantId) => {
      if (registeredParticipants.has(participantId)) {
        throw new Error(`Participant ${participantId} is already registered.`)
      }
      registeredParticipants.add(participantId)
    },
    sealParticipants: () => registeredParticipants.size,
    abortRun,
    cancelExecutionGroup: cancelAllActiveCommands,
    joinTimeoutMs: 2000,
    maxAbsoluteLatenessMs: 2000,
    cleanupDelayMs: 5000,
    onReleased: released
  })

  return {
    coordinator,
    abortRun,
    cancelAllActiveCommands,
    registeredParticipants,
    released
  }
}

describe('FactoryRunLocalStartBarrierCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME_MS)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('releases a complete 6/6 cohort exactly at the scheduled time', async () => {
    const harness = createHarness()
    const controllers = Array.from({ length: 6 }, () => new AbortController())
    const waits = controllers.map((controller, index) =>
      harness.coordinator.waitForStart(
        'run-1',
        `robot-${index + 1}`,
        scheduledAt(1000),
        6,
        controller.signal
      )
    )

    await vi.advanceTimersByTimeAsync(999)
    expect(harness.released).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    const releasedAt = await Promise.all(waits)

    expect(new Set(releasedAt).size).toBe(1)
    expect(harness.registeredParticipants.size).toBe(6)
    expect(harness.released).toHaveBeenCalledWith(
      expect.objectContaining({ participantCount: 6, absoluteLateByMs: 0 })
    )
    expect(harness.abortRun).not.toHaveBeenCalled()
  })

  it('releases immediately when the final participant arrives late but within tolerance', async () => {
    const harness = createHarness()
    const first = harness.coordinator.waitForStart(
      'run-1',
      'robot-1',
      scheduledAt(1000),
      2,
      new AbortController().signal
    )

    await vi.advanceTimersByTimeAsync(1100)

    const second = harness.coordinator.waitForStart(
      'run-1',
      'robot-2',
      scheduledAt(1000),
      2,
      new AbortController().signal
    )

    const results = await Promise.all([first, second])

    expect(results[0]).toBe(results[1])
    expect(harness.released).toHaveBeenCalledWith(
      expect.objectContaining({ participantCount: 2, absoluteLateByMs: 100 })
    )
  })

  it('releases a complete cohort 2206 ms late on one shared monotonic epoch', async () => {
    let nowUtcMs = BASE_TIME_MS
    let nextTimerId = 0
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
    const registeredParticipants = new Set<string>()
    const abortRun = vi.fn()
    const cancelExecutionGroup = vi.fn()
    const released = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const coordinator = new FactoryRunLocalStartBarrierCoordinator({
      registerParticipant: (_factoryRunId, participantId) => {
        registeredParticipants.add(participantId)
      },
      sealParticipants: () => registeredParticipants.size,
      abortRun,
      cancelExecutionGroup,
      nowUtcMs: () => nowUtcMs,
      nowMonotonicMs: () => nowUtcMs - BASE_TIME_MS,
      setTimer: (callback) => {
        const timerId = ++nextTimerId as unknown as ReturnType<typeof setTimeout>
        timers.set(timerId, callback)
        return timerId
      },
      clearTimer: (timerId) => {
        timers.delete(timerId)
      },
      maxAbsoluteLatenessMs: 2000,
      hardMaxAbsoluteLatenessMs: 30000,
      onReleased: released
    })

    const first = coordinator.waitForStart(
      'run-late',
      'robot-1',
      scheduledAt(1000),
      2,
      new AbortController().signal
    )
    const second = coordinator.waitForStart(
      'run-late',
      'robot-2',
      scheduledAt(1000),
      2,
      new AbortController().signal
    )

    expect(timers.size).toBe(1)
    nowUtcMs = BASE_TIME_MS + 3206
    const releaseTimer = [...timers.values()][0]
    releaseTimer()

    const results = await Promise.all([first, second])

    expect(results[0]).toBe(results[1])
    expect(abortRun).not.toHaveBeenCalled()
    expect(cancelExecutionGroup).not.toHaveBeenCalled()
    expect(released).toHaveBeenCalledWith(
      expect.objectContaining({
        absoluteLateByMs: 2206,
        releasedAfterSoftDeadline: true
      })
    )
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('does not abort IsolateTarget while slow arm requests join after the strict timeout', async () => {
    const harness = createHarness()
    const controllers = Array.from({ length: 6 }, () => new AbortController())
    const waits = [
      harness.coordinator.waitForStart(
        'run-slow-arm',
        'robot-1',
        scheduledAt(1000),
        6,
        controllers[0].signal,
        'IsolateTarget'
      )
    ]

    await vi.advanceTimersByTimeAsync(4489)

    for (let index = 1; index < controllers.length; index++) {
      waits.push(
        harness.coordinator.waitForStart(
          'run-slow-arm',
          `robot-${index + 1}`,
          scheduledAt(1000),
          6,
          controllers[index].signal,
          'IsolateTarget'
        )
      )
    }

    const releasedAt = await Promise.all(waits)

    expect(new Set(releasedAt).size).toBe(1)
    expect(harness.registeredParticipants.size).toBe(6)
    expect(harness.abortRun).not.toHaveBeenCalled()
    expect(harness.cancelAllActiveCommands).not.toHaveBeenCalled()
  })

  it('seals IsolateTarget survivors without cancelling them when a participant never joins', async () => {
    const harness = createHarness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const survivor = harness.coordinator.waitForStart(
      'run-missing-target',
      'robot-1',
      scheduledAt(100),
      2,
      new AbortController().signal,
      'IsolateTarget'
    )

    await vi.advanceTimersByTimeAsync(10100)
    await expect(survivor).resolves.toEqual(expect.any(Number))

    expect(harness.registeredParticipants).toEqual(new Set(['robot-1']))
    expect(harness.abortRun).not.toHaveBeenCalled()
    expect(harness.cancelAllActiveCommands).not.toHaveBeenCalled()

    expect(() =>
      harness.coordinator.waitForStart(
        'run-missing-target',
        'robot-2',
        scheduledAt(100),
        2,
        new AbortController().signal,
        'IsolateTarget'
      )
    ).toThrow(/late participant was isolated/i)

    expect(harness.abortRun).not.toHaveBeenCalled()
    expect(harness.cancelAllActiveCommands).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('times out and never seals an incomplete 5/6 cohort', async () => {
    const harness = createHarness()
    const waits = Array.from({ length: 5 }, (_, index) =>
      harness.coordinator.waitForStart(
        'run-1',
        `robot-${index + 1}`,
        scheduledAt(100),
        6,
        new AbortController().signal
      )
    )
    const settled = Promise.allSettled(waits)

    await vi.advanceTimersByTimeAsync(2100)
    const results = await settled

    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(harness.registeredParticipants.size).toBe(0)
    expect(harness.abortRun).toHaveBeenCalledOnce()
    expect(harness.cancelAllActiveCommands).toHaveBeenCalledOnce()
  })

  it('rejects the cohort when targets receive different participant counts', async () => {
    const harness = createHarness()
    const first = harness.coordinator.waitForStart(
      'run-1',
      'robot-1',
      scheduledAt(1000),
      2,
      new AbortController().signal
    )
    const firstResult = first.catch((error: unknown) => error)

    expect(() =>
      harness.coordinator.waitForStart(
        'run-1',
        'robot-2',
        scheduledAt(1000),
        3,
        new AbortController().signal
      )
    ).toThrow(/different participant counts/i)

    await expect(firstResult).resolves.toBeInstanceOf(Error)
    expect(harness.abortRun).toHaveBeenCalledOnce()
  })

  it('rejects the cohort when targets receive different start timestamps', async () => {
    const harness = createHarness()
    const first = harness.coordinator.waitForStart(
      'run-1',
      'robot-1',
      scheduledAt(1000),
      2,
      new AbortController().signal
    )
    const firstResult = first.catch((error: unknown) => error)

    expect(() =>
      harness.coordinator.waitForStart(
        'run-1',
        'robot-2',
        scheduledAt(1010),
        2,
        new AbortController().signal
      )
    ).toThrow(/different synchronized start timestamps/i)

    await expect(firstResult).resolves.toBeInstanceOf(Error)
    expect(harness.abortRun).toHaveBeenCalledOnce()
  })

  it('rejects duplicate participant IDs', async () => {
    const harness = createHarness()
    const first = harness.coordinator.waitForStart(
      'run-1',
      'robot-1',
      scheduledAt(1000),
      2,
      new AbortController().signal
    )
    const firstResult = first.catch((error: unknown) => error)

    expect(() =>
      harness.coordinator.waitForStart(
        'run-1',
        'robot-1',
        scheduledAt(1000),
        2,
        new AbortController().signal
      )
    ).toThrow(/more than once/i)

    await expect(firstResult).resolves.toBeInstanceOf(Error)
    expect(harness.abortRun).toHaveBeenCalledOnce()
  })

  it('aborts the whole cohort when one participant is cancelled before release', async () => {
    const harness = createHarness()
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = harness.coordinator.waitForStart(
      'run-1',
      'robot-1',
      scheduledAt(1000),
      3,
      firstController.signal
    )
    const second = harness.coordinator.waitForStart(
      'run-1',
      'robot-2',
      scheduledAt(1000),
      3,
      secondController.signal
    )
    const settled = Promise.allSettled([first, second])

    firstController.abort('test cancellation')
    const results = await settled

    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(harness.abortRun).toHaveBeenCalledOnce()
    expect(harness.cancelAllActiveCommands).toHaveBeenCalledOnce()
  })

  it('isolates a cancelled participant and releases the surviving local cohort', async () => {
    const harness = createHarness()
    const controllers = Array.from({ length: 3 }, () => new AbortController())
    const waits = controllers.map((controller, index) =>
      harness.coordinator.waitForStart(
        'run-1',
        `robot-${index + 1}`,
        scheduledAt(1000),
        3,
        controller.signal,
        'IsolateTarget'
      )
    )
    const settled = Promise.allSettled(waits)

    controllers[2].abort('robot-3 failed')
    await vi.advanceTimersByTimeAsync(1000)

    const results = await settled

    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('fulfilled')
    expect(results[2].status).toBe('rejected')
    expect(harness.released).toHaveBeenCalledWith(expect.objectContaining({ participantCount: 2 }))
    expect(harness.abortRun).not.toHaveBeenCalled()
    expect(harness.cancelAllActiveCommands).not.toHaveBeenCalled()
  })

  it('accepts a backend cohort reduction from 6 to 5 for IsolateTarget', async () => {
    const harness = createHarness()
    const waits = Array.from({ length: 5 }, (_, index) =>
      harness.coordinator.waitForStart(
        'run-1',
        `robot-${index + 1}`,
        scheduledAt(1000),
        index === 0 ? 6 : 5,
        new AbortController().signal,
        'IsolateTarget'
      )
    )

    await vi.advanceTimersByTimeAsync(1000)
    const results = await Promise.all(waits)

    expect(new Set(results).size).toBe(1)
    expect(harness.registeredParticipants.size).toBe(5)
    expect(harness.abortRun).not.toHaveBeenCalled()
    expect(harness.cancelAllActiveCommands).not.toHaveBeenCalled()
  })

  it('rejects an extra participant before a complete cohort is released', async () => {
    const harness = createHarness()
    const first = harness.coordinator.waitForStart(
      'run-1',
      'robot-1',
      scheduledAt(1000),
      2,
      new AbortController().signal
    )
    const second = harness.coordinator.waitForStart(
      'run-1',
      'robot-2',
      scheduledAt(1000),
      2,
      new AbortController().signal
    )
    const settled = Promise.allSettled([first, second])

    const third = harness.coordinator.waitForStart(
      'run-1',
      'robot-3',
      scheduledAt(1000),
      2,
      new AbortController().signal
    )
    const thirdResult = third.catch((error: unknown) => error)

    const firstTwoResults = await settled
    await expect(thirdResult).resolves.toBeInstanceOf(Error)
    expect(firstTwoResults.every((result) => result.status === 'rejected')).toBe(true)
    expect(harness.abortRun).toHaveBeenCalledOnce()
  })
})
