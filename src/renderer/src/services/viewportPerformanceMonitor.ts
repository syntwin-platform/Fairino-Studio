export type ViewportPerformanceStage = 'collision' | 'measurement' | 'render'

export interface ViewportPerformanceSnapshot {
  sampleCount: number
  medianFps: number
  p95FrameIntervalMs: number
  p95FrameWorkMs: number
  p95CollisionMs: number
  p95MeasurementMs: number
  p95RenderMs: number
  slowFramePercentage: number
}

interface ViewportPerformanceMonitorOptions {
  enabled?: boolean
  maxSamples?: number
  reportEveryMs?: number
  now?: () => number
  reporter?: (snapshot: ViewportPerformanceSnapshot) => void
}

const DEFAULT_MAX_SAMPLES = 600
const DEFAULT_REPORT_INTERVAL_MS = 5000
const SLOW_FRAME_THRESHOLD_MS = 1000 / 55

class RollingSamples {
  private readonly values: Float64Array
  private count = 0
  private writeIndex = 0

  constructor(capacity: number) {
    this.values = new Float64Array(capacity)
  }

  push(value: number): void {
    if (!Number.isFinite(value) || value < 0) return

    this.values[this.writeIndex] = value
    this.writeIndex = (this.writeIndex + 1) % this.values.length
    this.count = Math.min(this.count + 1, this.values.length)
  }

  toArray(): number[] {
    return Array.from(this.values.subarray(0, this.count))
  }

  get size(): number {
    return this.count
  }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0

  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1)

  return sorted[index]
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function isViewportPerformanceDiagnosticsEnabled(): boolean {
  if (typeof window === 'undefined') return false

  try {
    return window.localStorage.getItem('syntwin.viewport.performanceDebug') === 'true'
  } catch {
    return false
  }
}

export class ViewportPerformanceMonitor {
  readonly enabled: boolean

  private readonly now: () => number
  private readonly reportEveryMs: number
  private readonly reporter: (snapshot: ViewportPerformanceSnapshot) => void

  private readonly frameIntervals: RollingSamples
  private readonly frameWork: RollingSamples
  private readonly stages: Record<ViewportPerformanceStage, RollingSamples>

  private previousFrameTimestampMs: number | null = null
  private frameWorkStartedAtMs = 0
  private lastReportAtMs: number

  constructor(options: ViewportPerformanceMonitorOptions = {}) {
    const maxSamples = Math.max(10, Math.floor(options.maxSamples ?? DEFAULT_MAX_SAMPLES))

    this.enabled = options.enabled ?? isViewportPerformanceDiagnosticsEnabled()
    this.now = options.now ?? (() => performance.now())
    this.reportEveryMs = Math.max(1000, options.reportEveryMs ?? DEFAULT_REPORT_INTERVAL_MS)
    this.reporter =
      options.reporter ??
      ((snapshot) => {
        console.info('[ViewportPerformance]', snapshot)
      })

    this.frameIntervals = new RollingSamples(maxSamples)
    this.frameWork = new RollingSamples(maxSamples)
    this.stages = {
      collision: new RollingSamples(maxSamples),
      measurement: new RollingSamples(maxSamples),
      render: new RollingSamples(maxSamples)
    }

    this.lastReportAtMs = this.now()
  }

  beginFrame(frameTimestampMs: number): void {
    if (!this.enabled) return

    if (this.previousFrameTimestampMs !== null) {
      this.frameIntervals.push(frameTimestampMs - this.previousFrameTimestampMs)
    }

    this.previousFrameTimestampMs = frameTimestampMs
    this.frameWorkStartedAtMs = this.now()
  }

  beginStage(): number {
    return this.enabled ? this.now() : 0
  }

  endStage(stage: ViewportPerformanceStage, startedAtMs: number): void {
    if (!this.enabled) return

    this.stages[stage].push(this.now() - startedAtMs)
  }

  endFrame(): void {
    if (!this.enabled) return

    const completedAtMs = this.now()
    this.frameWork.push(completedAtMs - this.frameWorkStartedAtMs)

    if (completedAtMs - this.lastReportAtMs >= this.reportEveryMs) {
      this.lastReportAtMs = completedAtMs
      this.reporter(this.getSnapshot())
    }
  }

  getSnapshot(): ViewportPerformanceSnapshot {
    const frameIntervals = this.frameIntervals.toArray()
    const medianFrameIntervalMs = percentile(frameIntervals, 0.5)
    const slowFrameCount = frameIntervals.filter(
      (durationMs) => durationMs > SLOW_FRAME_THRESHOLD_MS
    ).length

    return {
      sampleCount: this.frameIntervals.size,
      medianFps: round(medianFrameIntervalMs > 0 ? 1000 / medianFrameIntervalMs : 0),
      p95FrameIntervalMs: round(percentile(frameIntervals, 0.95)),
      p95FrameWorkMs: round(percentile(this.frameWork.toArray(), 0.95)),
      p95CollisionMs: round(percentile(this.stages.collision.toArray(), 0.95)),
      p95MeasurementMs: round(percentile(this.stages.measurement.toArray(), 0.95)),
      p95RenderMs: round(percentile(this.stages.render.toArray(), 0.95)),
      slowFramePercentage: round(
        frameIntervals.length > 0 ? (slowFrameCount / frameIntervals.length) * 100 : 0
      )
    }
  }
}

export function createViewportPerformanceMonitor(
  options: ViewportPerformanceMonitorOptions = {}
): ViewportPerformanceMonitor {
  return new ViewportPerformanceMonitor(options)
}
