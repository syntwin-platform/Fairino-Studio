import { describe, expect, it } from 'vitest'
import { CartesianTraceRecorder, isAuthoritativeRecordedTraceStep } from './cartesianTraceRecorder'
import type { CartesianTraceSample } from '../types/cartesianTrace.types'
import type { JointAngles, TCPPose, WorkflowStep } from '../types/robot.types'

const angles: JointAngles = [0, -58.5, 93.6, -149.6, -90.2, 0]

function sample(
  elapsedMs: number,
  x: number,
  y = 0,
  z = 0,
  jointAngles: JointAngles = angles
): CartesianTraceSample {
  const tcpPose: TCPPose = { x, y, z, rx: 0, ry: 0, rz: 0 }
  return { elapsedMs, tcpPose, jointAngles: [...jointAngles] }
}

describe('CartesianTraceRecorder', () => {
  it('treats only MoveL trace samples with recorded joints as authoritative', () => {
    const traceStep: WorkflowStep = {
      id: 'recorded-trace-point',
      type: 'MoveL',
      label: 'Trace point 1',
      jointAngles: [...angles],
      tcpPose: sample(40, 10).tcpPose,
      speed: 30,
      acc: 30,
      trace: {
        groupId: 'trace-group',
        sampleIndex: 0,
        sampleCount: 1,
        segmentDurationMs: 40
      }
    }

    expect(isAuthoritativeRecordedTraceStep(traceStep)).toBe(true)
    expect(isAuthoritativeRecordedTraceStep({ ...traceStep, trace: undefined })).toBe(false)
    expect(isAuthoritativeRecordedTraceStep({ ...traceStep, jointAngles: undefined })).toBe(false)
    expect(isAuthoritativeRecordedTraceStep({ ...traceStep, type: 'MoveJ' })).toBe(false)
  })

  it('filters high-frequency noise and creates normal motion steps', () => {
    const recorder = new CartesianTraceRecorder({ simplifyToleranceMm: 0.1 })

    recorder.start(sample(0, 0))
    expect(recorder.append(sample(10, 10))).toBe(false)
    expect(recorder.append(sample(40, 1))).toBe(false)
    expect(recorder.append(sample(80, 10))).toBe(true)
    recorder.stop(sample(160, 20))

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

  it('preserves a speed change on a geometrically straight trace', () => {
    const recorder = new CartesianTraceRecorder({
      sampleIntervalMs: 1,
      minPositionDeltaMm: 0.1,
      simplifyToleranceMm: 1,
      simplifyJointToleranceDeg: 100
    })

    recorder.start(sample(0, 0))
    // At constant speed between 0 mm/0 ms and 100 mm/1000 ms this sample would be at 10 mm.
    // Its 40 mm position records a fast first movement and must not be simplified away.
    recorder.append(sample(100, 40))
    recorder.stop(sample(1000, 100))

    const motionSteps = recorder.buildSteps([]).filter((step) => step.type === 'MoveL')
    expect(motionSteps).toHaveLength(2)
    expect(motionSteps[0].tcpPose?.x).toBe(40)
    expect(motionSteps[0].trace?.segmentDurationMs).toBe(100)
    expect(motionSteps[1].trace?.segmentDurationMs).toBe(900)
  })

  it('preserves a joint-space bend even when the TCP path is perfectly straight', () => {
    const recorder = new CartesianTraceRecorder({
      sampleIntervalMs: 1,
      minPositionDeltaMm: 0.1,
      minJointDeltaDeg: 0.1,
      simplifyToleranceMm: 100,
      simplifyJointToleranceDeg: 0.5
    })
    const bentAngles: JointAngles = [...angles]
    bentAngles[1] += 25

    recorder.start(sample(0, 0))
    recorder.append(sample(50, 10, 0, 0, bentAngles))
    recorder.stop(sample(100, 20))

    const steps = recorder.buildSteps([])
    expect(steps.map((step) => step.type)).toEqual(['MoveJ', 'MoveL', 'MoveL'])
    expect(steps[1].jointAngles?.[1]).toBe(bentAngles[1])
    expect(steps[2].jointAngles?.[1]).toBe(angles[1])
  })

  it('records joint-only movement while the TCP pose remains unchanged', () => {
    const recorder = new CartesianTraceRecorder({
      sampleIntervalMs: 1,
      minJointDeltaDeg: 0.1
    })
    const wristAngles: JointAngles = [...angles]
    wristAngles[3] += 12

    recorder.start(sample(0, 10))
    expect(recorder.append(sample(40, 10, 0, 0, wristAngles))).toBe(true)
    recorder.stop()

    const steps = recorder.buildSteps([])
    expect(steps).toHaveLength(2)
    expect(steps[1].jointAngles?.[3]).toBe(wristAngles[3])
  })

  it('captures a joint-only final pose when the pointer is released', () => {
    const recorder = new CartesianTraceRecorder({ sampleIntervalMs: 1 })
    const finalAngles: JointAngles = [...angles]
    finalAngles[4] += 15

    recorder.start(sample(0, 10))
    recorder.stop(sample(40, 10, 0, 0, finalAngles))

    const steps = recorder.buildSteps([])
    expect(steps).toHaveLength(2)
    expect(steps[1].jointAngles?.[4]).toBe(finalAngles[4])
  })

  it('adds an approach when the TCP matches but the recorded joint branch differs', () => {
    const recorder = new CartesianTraceRecorder({
      sampleIntervalMs: 1,
      minPositionDeltaMm: 0.1,
      simplifyToleranceMm: 0.1
    })
    const traceStartAngles: JointAngles = [...angles]
    traceStartAngles[0] += 10
    recorder.start(sample(0, 10, 0, 0, traceStartAngles))
    recorder.stop(sample(40, 20, 0, 0, traceStartAngles))

    const previous: WorkflowStep = {
      id: 'previous-different-joint-branch',
      type: 'MoveL',
      label: 'Previous',
      jointAngles: [...angles],
      tcpPose: sample(0, 10).tcpPose,
      speed: 30,
      acc: 30
    }

    const steps = recorder.buildSteps([previous])
    expect(steps.map((step) => step.type)).toEqual(['MoveJ', 'MoveL'])
    expect(steps[0].label).toBe('Trace approach')
    expect(steps[0].jointAngles?.[0]).toBe(traceStartAngles[0])
  })
})
