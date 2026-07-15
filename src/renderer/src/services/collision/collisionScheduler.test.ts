import { describe, expect, it, vi } from 'vitest'

import { CollisionScheduler } from './collisionScheduler'

describe('CollisionScheduler', () => {
  it('does not overlap ticks and schedules the next tick after completion', async () => {
    vi.useFakeTimers()
    let releaseTick: (() => void) | undefined
    let activeTicks = 0
    let maximumActiveTicks = 0
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          activeTicks += 1
          maximumActiveTicks = Math.max(maximumActiveTicks, activeTicks)
          releaseTick = () => {
            activeTicks -= 1
            resolve()
          }
        })
    )
    const scheduler = new CollisionScheduler({ tick, intervalMs: 50 })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    expect(scheduler.isTickInFlight()).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    expect(tick).toHaveBeenCalledTimes(1)
    scheduler.requestImmediateTick()
    releaseTick?.()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(tick).toHaveBeenCalledTimes(2)
    expect(maximumActiveTicks).toBe(1)
    scheduler.stop()
    vi.useRealTimers()
  })

  it('contains tick errors and continues scheduling', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error('collision failure'))
      .mockResolvedValue(undefined)
    const scheduler = new CollisionScheduler({ tick, intervalMs: 50, onError })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(50)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(tick).toHaveBeenCalledTimes(2)
    scheduler.stop()
    vi.useRealTimers()
  })
})
