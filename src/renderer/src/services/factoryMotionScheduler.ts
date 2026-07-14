import { useRobotStore } from '../store/robotStore'
import type { JointAngles } from '../types/robot.types'
import { throwIfCommandCancelled } from './commandExecutionRuntime'
import { recordFactoryRunDiagnostic } from './factoryRunDiagnostics'
import { throwIfRobotMotionBlocked } from './robotFaultRuntime'

type EasingFn = (value: number) => number
type MotionSampler = (progress: number) => JointAngles

interface ScheduledJointMotion {
  robotId: string
  startedAtMonotonicMs: number
  durationMs: number
  signal: AbortSignal
  resolve: () => void
  reject: (error: unknown) => void
  sample: MotionSampler
  finalAngles: JointAngles
  firstFrameRecorded: boolean
}

const NOMINAL_FRAME_DURATION_MS = 1000 / 60
const FRAME_STALL_THRESHOLD_MS = 100

const motions = new Map<string, ScheduledJointMotion>()

let frameId = 0
let lastFrameAtMonotonicMs: number | null = null

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function cloneJointAngles(angles: JointAngles): JointAngles {
  return [...angles] as JointAngles
}

function validateJointAngles(angles: JointAngles, label: string): void {
  if (angles.length !== 6 || angles.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} must contain exactly 6 finite joint angles.`)
  }
}

export function calculateFrameStallCompensation(frameDeltaMs: number): number {
  if (!Number.isFinite(frameDeltaMs) || frameDeltaMs <= FRAME_STALL_THRESHOLD_MS) {
    return 0
  }

  return Math.max(0, frameDeltaMs - NOMINAL_FRAME_DURATION_MS)
}

export function sampleJointTrajectory(
  keyframes: readonly JointAngles[],
  rawProgress: number
): JointAngles {
  if (keyframes.length === 0) {
    throw new Error('Joint trajectory requires at least one keyframe.')
  }

  for (let index = 0; index < keyframes.length; index++) {
    validateJointAngles(keyframes[index], `Joint trajectory keyframe ${index + 1}`)
  }

  if (keyframes.length === 1) {
    return cloneJointAngles(keyframes[0])
  }

  const progress = clamp(rawProgress, 0, 1)
  const scaledProgress = progress * (keyframes.length - 1)
  const lowerIndex = Math.min(Math.floor(scaledProgress), keyframes.length - 2)
  const upperIndex = lowerIndex + 1
  const segmentProgress = scaledProgress - lowerIndex
  const lowerAngles = keyframes[lowerIndex]
  const upperAngles = keyframes[upperIndex]

  return lowerAngles.map((lowerAngle, jointIndex) => {
    const upperAngle = upperAngles[jointIndex]
    return lowerAngle + (upperAngle - lowerAngle) * segmentProgress
  }) as JointAngles
}

function ensureLoop(): void {
  if (frameId !== 0) {
    return
  }

  lastFrameAtMonotonicMs = performance.now()
  frameId = window.requestAnimationFrame(tick)
}

function stopLoopIfIdle(): void {
  if (motions.size > 0) {
    return
  }

  if (frameId !== 0) {
    window.cancelAnimationFrame(frameId)
  }

  frameId = 0
  lastFrameAtMonotonicMs = null
}

function compensateForSharedFrameStall(now: number): void {
  if (lastFrameAtMonotonicMs === null) {
    lastFrameAtMonotonicMs = now
    return
  }

  const frameDeltaMs = now - lastFrameAtMonotonicMs
  const compensationMs = calculateFrameStallCompensation(frameDeltaMs)

  lastFrameAtMonotonicMs = now

  if (compensationMs <= 0) {
    return
  }

  for (const motion of motions.values()) {
    motion.startedAtMonotonicMs += compensationMs
  }
}

function tick(now: number): void {
  frameId = 0

  compensateForSharedFrameStall(now)

  const patch: Record<string, JointAngles> = {}
  const completedRobotIds: string[] = []

  for (const [robotId, motion] of motions) {
    try {
      throwIfCommandCancelled(motion.signal)
      throwIfRobotMotionBlocked(robotId)
      if (!motion.firstFrameRecorded) {
        motion.firstFrameRecorded = true

        recordFactoryRunDiagnostic('robot.motion.first-frame', {
          robotId: motion.robotId,
          details: {
            startDelayMs: Math.max(0, now - motion.startedAtMonotonicMs),
            durationMs: motion.durationMs
          }
        })
      }

      const progress = clamp(
        (now - motion.startedAtMonotonicMs) / Math.max(16, motion.durationMs),
        0,
        1
      )

      patch[robotId] = motion.sample(progress)

      if (progress >= 1) {
        patch[robotId] = motion.finalAngles
        completedRobotIds.push(robotId)
      }
    } catch (error) {
      motions.delete(robotId)
      motion.reject(error)
    }
  }

  if (Object.keys(patch).length > 0) {
    useRobotStore.getState().setJointAnglesForRobots(patch)
  }

  for (const robotId of completedRobotIds) {
    const motion = motions.get(robotId)

    if (!motion) {
      continue
    }

    motions.delete(robotId)
    motion.resolve()
  }

  if (motions.size > 0) {
    frameId = window.requestAnimationFrame(tick)
  } else {
    stopLoopIfIdle()
  }
}

function scheduleMotion(
  robotId: string,
  durationMs: number,
  signal: AbortSignal,
  sample: MotionSampler,
  finalAngles: JointAngles,
  sharedStartedAtMonotonicMs?: number
): Promise<void> {
  const normalizedRobotId = robotId.trim()

  if (!normalizedRobotId) {
    return Promise.reject(new Error('Robot ID is required for scheduled motion.'))
  }

  try {
    throwIfRobotMotionBlocked(normalizedRobotId)
  } catch (error) {
    return Promise.reject(error)
  }

  validateJointAngles(finalAngles, 'Scheduled motion final angles')

  const startedAtMonotonicMs =
    typeof sharedStartedAtMonotonicMs === 'number' && Number.isFinite(sharedStartedAtMonotonicMs)
      ? sharedStartedAtMonotonicMs
      : performance.now()

  return new Promise((resolve, reject) => {
    if (motions.has(normalizedRobotId)) {
      reject(new Error(`Robot ${normalizedRobotId} already has a scheduled motion.`))
      return
    }

    motions.set(normalizedRobotId, {
      robotId: normalizedRobotId,
      startedAtMonotonicMs,
      durationMs: Math.max(16, durationMs),
      signal,
      resolve,
      reject,
      sample,
      finalAngles: cloneJointAngles(finalAngles),
      firstFrameRecorded: false
    })

    ensureLoop()
  })
}

export function runScheduledJointMotion(
  robotId: string,
  startAngles: JointAngles,
  targetAngles: JointAngles,
  durationMs: number,
  signal: AbortSignal,
  easing: EasingFn,
  sharedStartedAtMonotonicMs?: number
): Promise<void> {
  validateJointAngles(startAngles, 'Scheduled motion start angles')
  validateJointAngles(targetAngles, 'Scheduled motion target angles')

  const safeStartAngles = cloneJointAngles(startAngles)
  const safeTargetAngles = cloneJointAngles(targetAngles)

  return scheduleMotion(
    robotId,
    durationMs,
    signal,
    (progress) => {
      const easedProgress = easing(clamp(progress, 0, 1))

      return safeStartAngles.map((start, index) => {
        const target = safeTargetAngles[index]
        return start + (target - start) * easedProgress
      }) as JointAngles
    },
    safeTargetAngles,
    sharedStartedAtMonotonicMs
  )
}

export function runScheduledJointTrajectory(
  robotId: string,
  keyframes: readonly JointAngles[],
  durationMs: number,
  signal: AbortSignal,
  sharedStartedAtMonotonicMs?: number
): Promise<void> {
  if (keyframes.length === 0) {
    return Promise.reject(new Error('Joint trajectory requires at least one keyframe.'))
  }

  try {
    const safeKeyframes = keyframes.map((keyframe, index) => {
      validateJointAngles(keyframe, `Joint trajectory keyframe ${index + 1}`)
      return cloneJointAngles(keyframe)
    })

    return scheduleMotion(
      robotId,
      durationMs,
      signal,
      (progress) => sampleJointTrajectory(safeKeyframes, progress),
      safeKeyframes[safeKeyframes.length - 1],
      sharedStartedAtMonotonicMs
    )
  } catch (error) {
    return Promise.reject(error)
  }
}
