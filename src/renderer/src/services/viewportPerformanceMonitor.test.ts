import { describe, expect, it, vi } from 'vitest'
import { ViewportPerformanceMonitor } from './viewportPerformanceMonitor'

describe('ViewportPerformanceMonitor', () => {
  it('calculates frame and stage performance without per-frame reporting', () => {
    let nowMs = 0
    const reporter = vi.fn()

    const monitor = new ViewportPerformanceMonitor({
      enabled: true,
      maxSamples: 10,
      reportEveryMs: 5000,
      now: () => nowMs,
      reporter
    })

    monitor.beginFrame(0)

    let stageStartedAt = monitor.beginStage()
    nowMs = 2
    monitor.endStage('collision', stageStartedAt)

    stageStartedAt = monitor.beginStage()
    nowMs = 5
    monitor.endStage('measurement', stageStartedAt)

    stageStartedAt = monitor.beginStage()
    nowMs = 9
    monitor.endStage('render', stageStartedAt)

    nowMs = 10
    monitor.endFrame()

    nowMs = 20
    monitor.beginFrame(20)
    nowMs = 30
    monitor.endFrame()

    nowMs = 36
    monitor.beginFrame(36)
    nowMs = 46
    monitor.endFrame()

    const snapshot = monitor.getSnapshot()

    expect(snapshot.sampleCount).toBe(2)
    expect(snapshot.medianFps).toBe(62.5)
    expect(snapshot.p95FrameIntervalMs).toBe(20)
    expect(snapshot.p95CollisionMs).toBe(2)
    expect(snapshot.p95MeasurementMs).toBe(3)
    expect(snapshot.p95RenderMs).toBe(4)
    expect(reporter).not.toHaveBeenCalled()
  })

  it('publishes one bounded summary after the report interval', () => {
    let nowMs = 0
    const reporter = vi.fn()

    const monitor = new ViewportPerformanceMonitor({
      enabled: true,
      reportEveryMs: 1000,
      now: () => nowMs,
      reporter
    })

    monitor.beginFrame(0)
    nowMs = 10
    monitor.endFrame()

    nowMs = 1100
    monitor.beginFrame(16)
    nowMs = 1110
    monitor.endFrame()

    expect(reporter).toHaveBeenCalledTimes(1)
    expect(reporter.mock.calls[0][0].sampleCount).toBe(1)
  })

  it('does no measurement work when disabled', () => {
    const reporter = vi.fn()

    const monitor = new ViewportPerformanceMonitor({
      enabled: false,
      reporter
    })

    monitor.beginFrame(0)
    monitor.endStage('collision', monitor.beginStage())
    monitor.endFrame()

    expect(monitor.getSnapshot().sampleCount).toBe(0)
    expect(reporter).not.toHaveBeenCalled()
  })

  it('reports a six-robot acceptance window above 50 FPS with collision p95 below 10 ms', () => {
    let nowMs = 0
    const monitor = new ViewportPerformanceMonitor({
      enabled: true,
      maxSamples: 600,
      now: () => nowMs
    })

    for (let frame = 0; frame <= 600; frame += 1) {
      const frameTimestamp = frame * 16.67
      nowMs = frameTimestamp
      monitor.beginFrame(frameTimestamp)
      const collisionStartedAt = monitor.beginStage()
      nowMs += 4
      monitor.endStage('collision', collisionStartedAt)
      nowMs += 2
      monitor.endFrame()
    }

    const snapshot = monitor.getSnapshot()
    expect(snapshot.sampleCount).toBe(600)
    expect(snapshot.medianFps).toBeGreaterThanOrEqual(50)
    expect(snapshot.p95FrameIntervalMs).toBeLessThanOrEqual(20)
    expect(snapshot.p95CollisionMs).toBeLessThanOrEqual(10)
  })
})
