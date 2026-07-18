import type { CollisionSchedulerOptions } from './collisionTypes'

const DEFAULT_INTERVAL_MS = 1000 / 15

export class CollisionScheduler {
  private readonly intervalMs: number
  private readonly setTimer: NonNullable<CollisionSchedulerOptions['setTimer']>
  private readonly clearTimer: NonNullable<CollisionSchedulerOptions['clearTimer']>
  private readonly now: () => number
  private timerId: ReturnType<typeof setTimeout> | null = null
  private immediateTimerScheduled = false
  private running = false
  private inFlight = false
  private immediateTickRequested = false

  constructor(private readonly options: CollisionSchedulerOptions) {
    this.intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timerId) => clearTimeout(timerId))
    this.now = options.now ?? (() => performance.now())
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(0)
  }

  stop(): void {
    this.running = false
    this.immediateTickRequested = false
    this.immediateTimerScheduled = false
    if (this.timerId !== null) {
      this.clearTimer(this.timerId)
      this.timerId = null
    }
  }

  isRunning(): boolean {
    return this.running
  }

  isTickInFlight(): boolean {
    return this.inFlight
  }

  requestImmediateTick(): void {
    if (!this.running) return
    if (this.inFlight) {
      this.immediateTickRequested = true
      return
    }
    // Coalesce event storms (TransformControls, telemetry and joint state can all request the
    // same tick). Repeated clear/setTimeout(0) calls can otherwise postpone the tick indefinitely.
    if (this.immediateTimerScheduled) return
    if (this.timerId !== null) this.clearTimer(this.timerId)
    this.timerId = null
    this.immediateTimerScheduled = true
    this.schedule(0)
  }

  private schedule(delayMs: number): void {
    if (!this.running) return
    this.timerId = this.setTimer(() => {
      this.timerId = null
      this.immediateTimerScheduled = false
      void this.runTick()
    }, delayMs)
  }

  private async runTick(): Promise<void> {
    if (!this.running || this.inFlight) return
    this.inFlight = true
    const startedAt = this.now()
    try {
      await this.options.tick()
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.inFlight = false
      if (this.running) {
        const elapsedMs = Math.max(0, this.now() - startedAt)
        const delayMs = this.immediateTickRequested ? 0 : Math.max(0, this.intervalMs - elapsedMs)
        this.immediateTickRequested = false
        this.schedule(delayMs)
      }
    }
  }
}
