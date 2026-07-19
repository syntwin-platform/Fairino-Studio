import { describe, expect, it } from 'vitest'
import { CartesianTraceRecorder } from './cartesianTraceRecorder'
import type { CartesianTraceSample } from '../types/cartesianTrace.types'
import type { JointAngles, TCPPose, WorkflowStep } from '../types/robot.types'

const angles: JointAngles = [0, -58.5, 93.6, -149.6, -90.2, 0]

function sample(elapsedMs: number, x: number, y = 0, z = 0): CartesianTraceSample {
  const tcpPose: TCPPose = { x, y, z, rx: 0, ry: 0, rz: 0 }
  return { elapsedMs, tcpPose, jointAngles: [...angles] }
}

describe('CartesianTraceRecorder', () => {
  it('filters high-frequency noise and creates normal motion steps', () => {
    const recorder = new CartesianTraceRecorder({ simplifyToleranceMm: 0.1 })

    recorder.start(sample(0, 0))
    expect(recorder.append(sample(10, 10))).toBe(false)
    expect(recorder.append(sample(40, 1))).toBe(false)
    expect(recorder.append(sample(80, 10))).toBe(true)
    recorder.stop(sample(120, 20))

    const steps = recorder.buildSteps([])
    expect(steps.map((step) => step.type)).toEqual(['MoveJ', 'MoveL'])
    expect(steps.every((step) => step.trace?.groupId === steps[0].trace?.groupId)).toBe(true)
    expect(steps.at(-1)?.tcpPose?.x).toBe(20)
  })

  it('does not add an approach when the previous endpoint matches the trace start', () => {
    const recorder = new CartesianTraceRecorder({ simplifyToleranceMm: 0.1 })
    recorder.start(sample(0, 10))
    recorder.append(sample(40, 20))
    recorder.stop()

    const previous: WorkflowStep = {
      id: 'previous',
      type: 'MoveL',
      label: 'Previous',
      jointAngles: [...angles],
      tcpPose: sample(0, 10).tcpPose,
      speed: 30,
      acc: 30
    }

    const steps = recorder.buildSteps([previous])
    expect(steps).toHaveLength(1)
    expect(steps[0].type).toBe('MoveL')
    expect(steps[0].trace).toMatchObject({ sampleIndex: 0, sampleCount: 1 })
  })

  it('returns the initial pose when a draft is cancelled', () => {
    const recorder = new CartesianTraceRecorder()
    recorder.start(sample(0, 15))
    recorder.append(sample(40, 30))

    expect(recorder.cancel()?.tcpPose.x).toBe(15)
    expect(recorder.getSnapshot()).toEqual({ status: 'idle', rawSampleCount: 0, durationMs: 0 })
    expect(recorder.buildSteps([])).toEqual([])
  })

  it('resumes a paused trace without discarding its earlier samples', () => {
    const recorder = new CartesianTraceRecorder({
      sampleIntervalMs: 1,
      minPositionDeltaMm: 0.1,
      simplifyToleranceMm: 0.01
    })

    recorder.start(sample(0, 0))
    recorder.append(sample(40, 10))
    expect(recorder.stop()).toEqual({
      status: 'ready',
      rawSampleCount: 2,
      durationMs: 40
    })

    expect(recorder.resume()).toBe(true)
    expect(recorder.append(sample(80, 20))).toBe(true)
    expect(recorder.stop()).toEqual({
      status: 'ready',
      rawSampleCount: 3,
      durationMs: 80
    })
    expect(recorder.buildSteps([]).at(-1)?.tcpPose?.x).toBe(20)
  })

  it('preserves the recorded duration after path simplification', () => {
    const recorder = new CartesianTraceRecorder({
      sampleIntervalMs: 1,
      minPositionDeltaMm: 0.1,
      simplifyToleranceMm: 0.01
    })
    recorder.start(sample(0, 0))
    recorder.append(sample(40, 10, 5))
    recorder.append(sample(110, 20, -5))
    recorder.stop(sample(200, 30, 0))

    const traceDurationMs = recorder
      .buildSteps([])
      .filter((step) => step.type === 'MoveL')
      .reduce((duration, step) => duration + (step.trace?.segmentDurationMs ?? 0), 0)

    expect(traceDurationMs).toBe(200)
  })
})
