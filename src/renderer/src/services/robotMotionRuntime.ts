import type { JointAngles, TCPPose } from '../types/robot.types'
import { defaultRobotRuntimeConfig } from '../types/backendDevice'
import type { RobotRuntimeConfig } from '../types/backendDevice'

export interface PreparedMoveLTrajectory {
  keyframes: JointAngles[]
  waypointCount: number
  planningDurationMs: number
  durationMs?: number
  source?: 'ik' | 'recorded-trace'
  trace?: {
    groupId: string
    sampleIndex: number
    sampleCount: number
  }
}

export interface MoveLPlanningOptions {
  recordedTargetAngles?: JointAngles
  segmentDurationMs?: number
  trace?: {
    groupId: string
    sampleIndex: number
    sampleCount: number
  }
}

export interface MoveLRunOptions {
  managePlayingState?: boolean
  durationMs?: number
  startedAtMonotonicMs?: number
  preparedTrajectory?: PreparedMoveLTrajectory
}

type MoveLRunner = (
  tcpPose: TCPPose,
  speed: number,
  signal: AbortSignal,
  options?: MoveLRunOptions
) => Promise<void>

type MoveLPlanner = (
  tcpPose: TCPPose,
  speed: number,
  startAngles: JointAngles,
  signal: AbortSignal
) => Promise<PreparedMoveLTrajectory>

let moveLRunner: MoveLRunner | null = null

const moveLRunnersByRobotId = new Map<string, MoveLRunner>()
const moveLPlannersByRobotId = new Map<string, MoveLPlanner>()
const robotRuntimeConfigsByRobotId = new Map<string, RobotRuntimeConfig>()

let robotRuntimeConfig: RobotRuntimeConfig = defaultRobotRuntimeConfig

function cloneJointAngles(angles: JointAngles): JointAngles {
  return [...angles] as JointAngles
}

function validateJointAngles(angles: JointAngles, label: string): void {
  if (angles.length !== 6 || angles.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} must contain exactly 6 finite joint angles.`)
  }
}

function clonePreparedTrajectory(trajectory: PreparedMoveLTrajectory): PreparedMoveLTrajectory {
  if (trajectory.keyframes.length < 2) {
    throw new Error('Prepared MoveL trajectory requires at least two keyframes.')
  }

  if (
    !Number.isInteger(trajectory.waypointCount) ||
    trajectory.waypointCount < 1 ||
    trajectory.waypointCount !== trajectory.keyframes.length - 1
  ) {
    throw new Error('Prepared MoveL waypointCount must equal keyframes.length - 1.')
  }

  if (!Number.isFinite(trajectory.planningDurationMs) || trajectory.planningDurationMs < 0) {
    throw new Error('Prepared MoveL planningDurationMs must be a non-negative finite number.')
  }

  if (
    trajectory.durationMs !== undefined &&
    (!Number.isFinite(trajectory.durationMs) || trajectory.durationMs < 0)
  ) {
    throw new Error('Prepared MoveL durationMs must be a non-negative finite number.')
  }

  const keyframes = trajectory.keyframes.map((keyframe, index) => {
    validateJointAngles(keyframe, `Prepared MoveL keyframe ${index + 1}`)
    return cloneJointAngles(keyframe)
  })

  return {
    keyframes,
    waypointCount: trajectory.waypointCount,
    planningDurationMs: trajectory.planningDurationMs,
    durationMs: trajectory.durationMs,
    source: trajectory.source,
    trace: trajectory.trace ? { ...trajectory.trace } : undefined
  }
}

function cloneRobotRuntimeConfig(config: RobotRuntimeConfig): RobotRuntimeConfig {
  return {
    ...config,
    motionPolicy: {
      moveL: { ...config.motionPolicy.moveL },
      moveJ: { ...config.motionPolicy.moveJ }
    },
    jointLimits: config.jointLimits.map((limit) => ({ ...limit }))
  }
}

export function setRobotRuntimeConfig(config: RobotRuntimeConfig): void {
  const safeConfig = cloneRobotRuntimeConfig(config)
  const normalizedRobotId = safeConfig.robotId.trim()

  robotRuntimeConfig = safeConfig

  if (normalizedRobotId) {
    robotRuntimeConfigsByRobotId.set(normalizedRobotId, safeConfig)
  }
}

export function getRobotRuntimeConfig(robotId?: string): RobotRuntimeConfig {
  const normalizedRobotId = robotId?.trim()

  if (!normalizedRobotId) {
    return cloneRobotRuntimeConfig(robotRuntimeConfig)
  }

  const config = robotRuntimeConfigsByRobotId.get(normalizedRobotId)

  if (config) {
    return cloneRobotRuntimeConfig(config)
  }

  return cloneRobotRuntimeConfig({
    ...defaultRobotRuntimeConfig,
    robotId: normalizedRobotId
  })
}

export function registerMoveLRunner(runner: MoveLRunner): () => void {
  moveLRunner = runner

  return () => {
    if (moveLRunner === runner) {
      moveLRunner = null
    }
  }
}

export function registerMoveLRunnerForRobot(robotId: string, runner: MoveLRunner): () => void {
  const normalizedRobotId = robotId.trim()

  if (!normalizedRobotId) {
    throw new Error('Robot ID is required to register MoveL runner')
  }

  moveLRunnersByRobotId.set(normalizedRobotId, runner)

  return () => {
    if (moveLRunnersByRobotId.get(normalizedRobotId) === runner) {
      moveLRunnersByRobotId.delete(normalizedRobotId)
    }
  }
}

export function registerMoveLPlannerForRobot(robotId: string, planner: MoveLPlanner): () => void {
  const normalizedRobotId = robotId.trim()

  if (!normalizedRobotId) {
    throw new Error('Robot ID is required to register MoveL planner')
  }

  moveLPlannersByRobotId.set(normalizedRobotId, planner)

  return () => {
    if (moveLPlannersByRobotId.get(normalizedRobotId) === planner) {
      moveLPlannersByRobotId.delete(normalizedRobotId)
    }
  }
}

export async function prepareMoveLForRobot(
  robotId: string,
  tcpPose: TCPPose,
  speed: number,
  startAngles: JointAngles,
  signal: AbortSignal,
  options?: MoveLPlanningOptions
): Promise<PreparedMoveLTrajectory> {
  const normalizedRobotId = robotId.trim()

  validateJointAngles(startAngles, 'MoveL planning start angles')

  if (signal.aborted) {
    throw new Error(`MoveL planning was cancelled for robot ${normalizedRobotId}`)
  }

  if (options?.recordedTargetAngles) {
    const targetAngles = cloneJointAngles(options.recordedTargetAngles)
    const runtimeConfig = getRobotRuntimeConfig(normalizedRobotId)
    const traceLabel = options.trace
      ? `Trace point ${options.trace.sampleIndex}/${options.trace.sampleCount - 1}`
      : 'Recorded MoveL target'

    validateJointAngles(targetAngles, `${traceLabel} joint angles`)

    for (let jointIndex = 0; jointIndex < targetAngles.length; jointIndex++) {
      const limit = runtimeConfig.jointLimits.find((item) => item.joint === jointIndex + 1)

      if (
        limit &&
        (targetAngles[jointIndex] < limit.minDeg || targetAngles[jointIndex] > limit.maxDeg)
      ) {
        throw new Error(
          `${traceLabel} exceeds joint ${jointIndex + 1} limit ` +
            `[${limit.minDeg}, ${limit.maxDeg}] degrees for robot ${normalizedRobotId}`
        )
      }
    }

    const largestJointChange = Math.max(
      ...targetAngles.map((target, jointIndex) => Math.abs(target - startAngles[jointIndex]))
    )

    if (largestJointChange > runtimeConfig.motionPolicy.moveJ.maxJointDeltaDeg) {
      throw new Error(
        `${traceLabel} has an unsafe recorded joint jump of ` +
          `${largestJointChange.toFixed(1)} degrees for robot ${normalizedRobotId}`
      )
    }

    return clonePreparedTrajectory({
      keyframes: [cloneJointAngles(startAngles), targetAngles],
      waypointCount: 1,
      planningDurationMs: 0,
      durationMs: Math.max(16, options.segmentDurationMs ?? 16),
      source: 'recorded-trace',
      trace: options.trace ? { ...options.trace } : undefined
    })
  }

  const planner = moveLPlannersByRobotId.get(normalizedRobotId)

  if (!planner) {
    throw new Error(`Robot 3D is not ready for MoveL planning: ${normalizedRobotId}`)
  }

  const trajectory = await planner(tcpPose, speed, cloneJointAngles(startAngles), signal)

  return clonePreparedTrajectory(trajectory)
}

export async function runMoveL(
  tcpPose: TCPPose,
  speed: number,
  signal: AbortSignal,
  options?: MoveLRunOptions
): Promise<void> {
  if (!moveLRunner) {
    throw new Error('Robot 3D is not ready for MoveL')
  }

  await moveLRunner(tcpPose, speed, signal, options)
}

export async function runMoveLForRobot(
  robotId: string,
  tcpPose: TCPPose,
  speed: number,
  signal: AbortSignal,
  options?: MoveLRunOptions
): Promise<void> {
  const normalizedRobotId = robotId.trim()
  const runner = moveLRunnersByRobotId.get(normalizedRobotId)

  if (!runner) {
    throw new Error(`Robot 3D is not ready for MoveL: ${normalizedRobotId}`)
  }

  await runner(tcpPose, speed, signal, options)
}
