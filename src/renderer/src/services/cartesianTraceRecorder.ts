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
  simplifyToleranceMm: 1.5,
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
  toleranceMm: number,
  retainedIndices: Set<number>
): void {
  if (endIndex <= startIndex + 1) return

  let furthestIndex = -1
  let furthestDistance = toleranceMm

  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const distance = pointToSegmentDistance(
      samples[index].tcpPose,
      samples[startIndex].tcpPose,
      samples[endIndex].tcpPose
    )
    if (distance > furthestDistance) {
      furthestDistance = distance
      furthestIndex = index
    }
  }

  if (furthestIndex < 0) return
  retainedIndices.add(furthestIndex)
  simplifyRange(samples, startIndex, furthestIndex, toleranceMm, retainedIndices)
  simplifyRange(samples, furthestIndex, endIndex, toleranceMm, retainedIndices)
}

function simplifySamples(
  samples: CartesianTraceSample[],
  config: CartesianTraceConfig
): CartesianTraceSample[] {
  if (samples.length <= 2) return [...samples]

  const retainedIndices = new Set<number>([0, samples.length - 1])
  simplifyRange(samples, 0, samples.length - 1, config.simplifyToleranceMm, retainedIndices)

  for (let index = 1; index < samples.length - 1; index += 1) {
    if (
      rotationDistance(samples[index - 1].tcpPose, samples[index].tcpPose) >=
      config.minRotationDeltaDeg * 2
    ) {
      retainedIndices.add(index)
    }
  }

  const simplified = [...retainedIndices].sort((a, b) => a - b).map((index) => samples[index])

  if (simplified.length <= config.maxOutputPoints) return simplified

  const output: CartesianTraceSample[] = []
  const lastIndex = simplified.length - 1
  for (let index = 0; index < config.maxOutputPoints; index += 1) {
    const sourceIndex = Math.round((index / (config.maxOutputPoints - 1)) * lastIndex)
    const sample = simplified[sourceIndex]
    if (output.at(-1) !== sample) output.push(sample)
  }
  return output
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
    if (moved < this.config.minPositionDeltaMm && rotated < this.config.minRotationDeltaDeg) {
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
        rotationDistance(previous.tcpPose, finalSample.tcpPose) > 0.01)
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
      positionDistance(previous.tcpPose, first.tcpPose) <= 3 &&
      rotationDistance(previous.tcpPose, first.tcpPose) <= 1

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
