import type {
  CartesianTraceConfig,
  CartesianTraceSample,
  CartesianTraceSnapshot
} from '../types/cartesianTrace.types'
import type { TCPPose, WorkflowStep } from '../types/robot.types'

export const DEFAULT_CARTESIAN_TRACE_CONFIG: CartesianTraceConfig = {
  sampleIntervalMs: 33,
  minPositionDeltaMm: 2,
  minRotationDeltaDeg: 0.5,
  minJointDeltaDeg: 0.25,
  simplifyToleranceMm: 1.5,
  simplifyJointToleranceDeg: 0.35,
  maxDurationMs: 5 * 60 * 1000,
  maxRawSamples: 9000,
  maxOutputPoints: 1200,
  defaultSpeed: 30,
  defaultAcc: 30
}

type WorkflowStepDraft = Omit<WorkflowStep, 'id'>

function positionDistance(a: TCPPose, b: TCPPose): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function normalizedAngleDelta(a: number, b: number): number {
  let delta = Math.abs(a - b) % 360
  if (delta > 180) delta = 360 - delta
  return delta
}

function rotationDistance(a: TCPPose, b: TCPPose): number {
  return Math.max(
    normalizedAngleDelta(a.rx, b.rx),
    normalizedAngleDelta(a.ry, b.ry),
    normalizedAngleDelta(a.rz, b.rz)
  )
}

function jointDistance(
  a: CartesianTraceSample['jointAngles'],
  b: CartesianTraceSample['jointAngles']
): number {
  return Math.max(...a.map((angle, index) => Math.abs(angle - b[index])))
}

function jointInterpolationError(
  sample: CartesianTraceSample,
  start: CartesianTraceSample,
  end: CartesianTraceSample
): number {
  const durationMs = end.elapsedMs - start.elapsedMs
  const progress =
    durationMs > Number.EPSILON
      ? Math.max(0, Math.min(1, (sample.elapsedMs - start.elapsedMs) / durationMs))
      : 0

  return Math.max(
    ...sample.jointAngles.map((angle, index) => {
      const interpolated =
        start.jointAngles[index] + (end.jointAngles[index] - start.jointAngles[index]) * progress
      return Math.abs(angle - interpolated)
    })
  )
}

function timedPositionInterpolationError(
  sample: CartesianTraceSample,
  start: CartesianTraceSample,
  end: CartesianTraceSample
): number {
  const durationMs = end.elapsedMs - start.elapsedMs
  const progress =
    durationMs > Number.EPSILON
      ? Math.max(0, Math.min(1, (sample.elapsedMs - start.elapsedMs) / durationMs))
      : 0

  return Math.hypot(
    sample.tcpPose.x - (start.tcpPose.x + (end.tcpPose.x - start.tcpPose.x) * progress),
    sample.tcpPose.y - (start.tcpPose.y + (end.tcpPose.y - start.tcpPose.y) * progress),
    sample.tcpPose.z - (start.tcpPose.z + (end.tcpPose.z - start.tcpPose.z) * progress)
  )
}

function pointToSegmentDistance(point: TCPPose, start: TCPPose, end: TCPPose): number {
  const segmentX = end.x - start.x
  const segmentY = end.y - start.y
  const segmentZ = end.z - start.z
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY + segmentZ * segmentZ

  if (segmentLengthSquared <= Number.EPSILON) return positionDistance(point, start)

  const projection =
    ((point.x - start.x) * segmentX +
      (point.y - start.y) * segmentY +
      (point.z - start.z) * segmentZ) /
    segmentLengthSquared
  const t = Math.max(0, Math.min(1, projection))

  return Math.hypot(
    point.x - (start.x + segmentX * t),
    point.y - (start.y + segmentY * t),
    point.z - (start.z + segmentZ * t)
  )
}

function simplifyRange(
  samples: CartesianTraceSample[],
  startIndex: number,
  endIndex: number,
  config: CartesianTraceConfig,
  retainedIndices: Set<number>
): void {
  if (endIndex <= startIndex + 1) return

  let furthestIndex = -1
  let furthestScore = 1

  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const positionErrorMm = pointToSegmentDistance(
      samples[index].tcpPose,
      samples[startIndex].tcpPose,
      samples[endIndex].tcpPose
    )
    // Recorded traces are replayed by interpolating joint angles on their original timeline.
    // A Cartesian-only RDP pass can therefore remove a joint-space bend and create a robot pose
    // that the operator never made. Retain whichever sample has the largest normalized error in
    // either representation so playback follows both the drawn TCP path and the recorded posture.
    const jointErrorDeg = jointInterpolationError(
      samples[index],
      samples[startIndex],
      samples[endIndex]
    )
    // Spatial RDP alone removes points which lie on the same line even when the operator
    // accelerated, slowed down or used Shift/Ctrl. Playback then has the right shape but the
    // wrong speed. Compare against the position expected at the recorded timestamp as well.
    const timedPositionErrorMm = timedPositionInterpolationError(
      samples[index],
      samples[startIndex],
      samples[endIndex]
    )
    const score = Math.max(
      positionErrorMm / Math.max(config.simplifyToleranceMm, Number.EPSILON),
      timedPositionErrorMm / Math.max(config.simplifyToleranceMm, Number.EPSILON),
      jointErrorDeg / Math.max(config.simplifyJointToleranceDeg, Number.EPSILON)
    )

    if (score > furthestScore) {
      furthestScore = score
      furthestIndex = index
    }
  }

  if (furthestIndex < 0) return
  retainedIndices.add(furthestIndex)
  simplifyRange(samples, startIndex, furthestIndex, config, retainedIndices)
  simplifyRange(samples, furthestIndex, endIndex, config, retainedIndices)
}

function simplifySamples(
  samples: CartesianTraceSample[],
  config: CartesianTraceConfig
): CartesianTraceSample[] {
  if (samples.length <= 2) return [...samples]

  const retainedIndices = new Set<number>([0, samples.length - 1])
  simplifyRange(samples, 0, samples.length - 1, config, retainedIndices)

  for (let index = 1; index < samples.length - 1; index += 1) {
    if (
      rotationDistance(samples[index - 1].tcpPose, samples[index].tcpPose) >=
      config.minRotationDeltaDeg * 2
    ) {
      retainedIndices.add(index)
    }
  }

  const simplified = [...retainedIndices].sort((a, b) => a - b).map((index) => samples[index])

  // maxOutputPoints is a soft UI/storage target. Uniformly dropping safety-critical samples here
  // reintroduces the exact invalid-posture bug that the joint-aware pass prevents. A long trace is
  // allowed to exceed the target; a future packed MoveTrace representation can optimize storage
  // without changing the recorded motion.
  return simplified
}

function createTraceGroupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `trace_${crypto.randomUUID()}`
  }
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function previousMotionStep(steps: WorkflowStep[]): WorkflowStep | undefined {
  return [...steps].reverse().find((step) => step.type === 'MoveJ' || step.type === 'MoveL')
}

/**
 * A freehand trace stores the exact joint branch that the operator trained.
 * Re-solving these samples from TCP would be lossy because the same TCP pose
 * can have multiple valid IK solutions.
 */
export function isAuthoritativeRecordedTraceStep(
  step: WorkflowStep
): step is WorkflowStep & { jointAngles: NonNullable<WorkflowStep['jointAngles']> } {
  return step.type === 'MoveL' && step.trace !== undefined && step.jointAngles !== undefined
}

export class CartesianTraceRecorder {
  private readonly config: CartesianTraceConfig
  private samples: CartesianTraceSample[] = []
  private status: CartesianTraceSnapshot['status'] = 'idle'

  constructor(config: Partial<CartesianTraceConfig> = {}) {
    this.config = { ...DEFAULT_CARTESIAN_TRACE_CONFIG, ...config }
  }

  start(sample: CartesianTraceSample): void {
    this.samples = [{ ...sample, elapsedMs: 0 }]
    this.status = 'recording'
  }

  resume(): boolean {
    if (this.status !== 'ready' || this.samples.length < 2) return false

    this.status = 'recording'
    return true
  }

  append(sample: CartesianTraceSample): boolean {
    if (this.status !== 'recording') return false

    const first = this.samples[0]
    const previous = this.samples.at(-1)
    if (!first || !previous) return false
    if (sample.elapsedMs > this.config.maxDurationMs) return false
    if (this.samples.length >= this.config.maxRawSamples) return false
    if (sample.elapsedMs - previous.elapsedMs < this.config.sampleIntervalMs) return false

    const moved = positionDistance(previous.tcpPose, sample.tcpPose)
    const rotated = rotationDistance(previous.tcpPose, sample.tcpPose)
    const jointsMoved = jointDistance(previous.jointAngles, sample.jointAngles)
    if (
      moved < this.config.minPositionDeltaMm &&
      rotated < this.config.minRotationDeltaDeg &&
      jointsMoved < this.config.minJointDeltaDeg
    ) {
      return false
    }

    this.samples.push(sample)
    return true
  }

  stop(finalSample?: CartesianTraceSample): CartesianTraceSnapshot {
    if (this.status !== 'recording') return this.getSnapshot()

    const previous = this.samples.at(-1)
    if (
      finalSample &&
      previous &&
      (positionDistance(previous.tcpPose, finalSample.tcpPose) > 0.01 ||
        rotationDistance(previous.tcpPose, finalSample.tcpPose) > 0.01 ||
        jointDistance(previous.jointAngles, finalSample.jointAngles) > 0.01)
    ) {
      this.samples.push(finalSample)
    }

    this.status = this.samples.length > 1 ? 'ready' : 'idle'
    if (this.status === 'idle') this.samples = []
    return this.getSnapshot()
  }

  cancel(): CartesianTraceSample | null {
    const startSample = this.samples[0] ?? null
    this.samples = []
    this.status = 'idle'
    return startSample
  }

  getSnapshot(): CartesianTraceSnapshot {
    return {
      status: this.status,
      rawSampleCount: this.samples.length,
      durationMs: this.samples.at(-1)?.elapsedMs ?? 0
    }
  }

  buildSteps(existingSteps: WorkflowStep[]): WorkflowStepDraft[] {
    if (this.status !== 'ready') return []

    const samples = simplifySamples(this.samples, this.config)
    if (samples.length < 2) return []

    const groupId = createTraceGroupId()
    const result: WorkflowStepDraft[] = []
    const first = samples[0]
    const previous = previousMotionStep(existingSteps)
    const startsAtPreviousEndpoint =
      previous?.tcpPose !== undefined &&
      previous.jointAngles !== undefined &&
      positionDistance(previous.tcpPose, first.tcpPose) <= 3 &&
      rotationDistance(previous.tcpPose, first.tcpPose) <= 1 &&
      jointDistance(previous.jointAngles, first.jointAngles) <=
        this.config.simplifyJointToleranceDeg

    // When the previous workflow step already owns the trace start pose, the
    // first emitted command is samples[1]. Re-index the emitted commands so a
    // complete trace still starts at zero. Older exports kept the original
    // sample index and therefore produced a first command with sampleIndex=1.
    const emittedSampleOffset = startsAtPreviousEndpoint ? 1 : 0
    const emittedSampleCount = samples.length - emittedSampleOffset

    if (!startsAtPreviousEndpoint) {
      result.push({
        type: 'MoveJ',
        label: 'Trace approach',
        jointAngles: [...first.jointAngles],
        tcpPose: { ...first.tcpPose },
        speed: this.config.defaultSpeed,
        acc: this.config.defaultAcc,
        trace: {
          groupId,
          sampleIndex: 0,
          sampleCount: samples.length,
          segmentDurationMs: 0
        }
      })
    }

    for (let index = 1; index < samples.length; index += 1) {
      const sample = samples[index]
      const previousSample = samples[index - 1]
      result.push({
        type: 'MoveL',
        label: `Trace point ${index}`,
        jointAngles: [...sample.jointAngles],
        tcpPose: { ...sample.tcpPose },
        speed: this.config.defaultSpeed,
        acc: this.config.defaultAcc,
        trace: {
          groupId,
          sampleIndex: index - emittedSampleOffset,
          sampleCount: emittedSampleCount,
          segmentDurationMs: Math.max(0, sample.elapsedMs - previousSample.elapsedMs)
        }
      })
    }

    return result
  }
}
