import type { JointAngles, TCPPose } from './robot.types'

export type CartesianInteractionMode = 'point' | 'trace'
export type CartesianTraceStatus = 'idle' | 'recording' | 'ready'

export interface CartesianTraceSample {
  elapsedMs: number
  tcpPose: TCPPose
  jointAngles: JointAngles
}

export interface CartesianTraceConfig {
  sampleIntervalMs: number
  minPositionDeltaMm: number
  minRotationDeltaDeg: number
  minJointDeltaDeg: number
  simplifyToleranceMm: number
  simplifyJointToleranceDeg: number
  maxDurationMs: number
  maxRawSamples: number
  maxOutputPoints: number
  defaultSpeed: number
  defaultAcc: number
}

export interface CartesianTraceSnapshot {
  status: CartesianTraceStatus
  rawSampleCount: number
  durationMs: number
}
