import { useRobotStore } from '../store/robotStore'
import type { JointAngles, TCPPose } from '../types/robot.types'
import type { PendingDeviceCommand } from '../types/backendDevice'
import { prepareMoveLForRobot, runMoveL, runMoveLForRobot } from './robotMotionRuntime'
import type { PreparedMoveLTrajectory } from './robotMotionRuntime'
import { runScheduledJointMotion } from './factoryMotionScheduler'
import { factoryRunStepCoordinator } from './factoryRunStepCoordinator'
import { FactoryRunLocalStartBarrierCoordinator } from './factoryRunLocalStartBarrier'
import {
  CommandExecutionCancelledError,
  beginCommandExecutionForRobot,
  cancelActiveCommandsForGroup,
  cancelActiveCommandForRobot,
  finishCommandExecutionForRobot,
  throwIfCommandCancelled
} from './commandExecutionRuntime'
import { recordFactoryRunDiagnostic } from './factoryRunDiagnostics'
import { latchRobotFault, throwIfRobotMotionBlocked } from './robotFaultRuntime'
const FACTORY_RUN_DEBUG =
  typeof window !== 'undefined' &&
  window.localStorage.getItem('syntwin.factoryRun.debug') === 'true'

const FACTORY_RUN_ARM_MAX_ATTEMPTS = 150
const FACTORY_RUN_ARM_POLL_INTERVAL_MS = 200
const FACTORY_RUN_MAX_STANDALONE_START_LATENESS_MS = 250
const FACTORY_RUN_MAX_ABSOLUTE_COHORT_LATENESS_MS = 2000
const FACTORY_RUN_HARD_MAX_ABSOLUTE_COHORT_LATENESS_MS = 30000
const FACTORY_RUN_LOCAL_COHORT_JOIN_TIMEOUT_MS = 2000

const factoryRunLocalStartBarrier = new FactoryRunLocalStartBarrierCoordinator({
  registerParticipant: (factoryRunId, participantId) =>
    factoryRunStepCoordinator.registerParticipant(factoryRunId, participantId),
  sealParticipants: (factoryRunId) => factoryRunStepCoordinator.sealParticipants(factoryRunId),
  abortRun: (factoryRunId, reason) => factoryRunStepCoordinator.abortRun(factoryRunId, reason),
  cancelExecutionGroup: (factoryRunId, reason) => {
    cancelActiveCommandsForGroup(factoryRunId, reason)
  },
  joinTimeoutMs: FACTORY_RUN_LOCAL_COHORT_JOIN_TIMEOUT_MS,
  maxAbsoluteLatenessMs: FACTORY_RUN_MAX_ABSOLUTE_COHORT_LATENESS_MS,
  hardMaxAbsoluteLatenessMs: FACTORY_RUN_HARD_MAX_ABSOLUTE_COHORT_LATENESS_MS,
  onReleased: FACTORY_RUN_DEBUG
    ? (event) => console.debug('[FactoryRun] local cohort released', event)
    : undefined
})

interface MoveJPayload {
  jointAngles: number[]
  speed?: number
  acc?: number
}

interface MoveLPayload {
  tcpPose: TCPPose
  speed?: number
  acc?: number
}

interface RotateJointPayload {
  jointIndex: number
  angle: number
  speed?: number
  acc?: number
}

interface SetDOPayload {
  doType: 'cabinet' | 'tool'
  doIndex: number
  doValue: 0 | 1
}

interface RunProgramStep {
  orderIndex: number
  stepType: string
  label?: string
  payload?: unknown
}

interface PreparedRunProgramExecution {
  estimatedStepDurationsMs: number[]
  moveLTrajectoriesByStepIndex: Map<number, PreparedMoveLTrajectory>
}

interface FactoryRunArmPayload {
  factoryRunId: string
  targetId: string
  failurePolicy: 'IsolateTarget' | 'AbortExecutionGroup'
}

export interface FactoryRunArmResponse {
  isReady: boolean
  scheduledStartAtUtc?: string | null
  expectedParticipantCount: number
  stepDurationsMs?: number[] | null
}

export interface BackendCommandExecutionContext {
  armFactoryRunCommand?: (
    payload: FactoryRunArmPayload,
    estimatedStepDurationsMs: number[],
    signal: AbortSignal
  ) => Promise<FactoryRunArmResponse>

  reportFactoryRunStarted?: (
    payload: FactoryRunArmPayload,
    actualStartedAtUtc: string,
    signal: AbortSignal
  ) => Promise<void>
}

export interface CommandExecutionFailureMetadata {
  source: string
  stepIndex?: number
  stepOrderIndex?: number
  stepType?: string
  stepLabel?: string
  technicalMessage: string
}

export class CommandExecutionError extends Error {
  metadata: CommandExecutionFailureMetadata

  constructor(message: string, metadata: CommandExecutionFailureMetadata) {
    super(message)
    this.name = 'CommandExecutionError'
    this.metadata = metadata
  }
}

export function getCommandExecutionFailureMetadata(
  error: unknown
): CommandExecutionFailureMetadata | null {
  return error instanceof CommandExecutionError ? error.metadata : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateMotionValue(value: unknown, fieldName: 'speed' | 'acc'): void {
  if (value !== undefined && (!isFiniteNumber(value) || value < 1 || value > 100)) {
    throw new Error(`${fieldName} must be between 1 and 100`)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfCommandCancelled(signal)

  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      window.clearTimeout(timeoutId)
      signal.removeEventListener('abort', handleAbort)

      try {
        throwIfCommandCancelled(signal)
      } catch (error) {
        reject(error)
      }
    }

    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

function waitForAnimationFrame(signal: AbortSignal): Promise<number> {
  throwIfCommandCancelled(signal)

  return new Promise((resolve, reject) => {
    let frameId = 0

    const handleAbort = (): void => {
      window.cancelAnimationFrame(frameId)
      signal.removeEventListener('abort', handleAbort)

      try {
        throwIfCommandCancelled(signal)
      } catch (error) {
        reject(error)
      }
    }

    frameId = window.requestAnimationFrame((now) => {
      signal.removeEventListener('abort', handleAbort)
      resolve(now)
    })

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

function assertMotionCanContinue(signal: AbortSignal, robotId?: string): void {
  throwIfCommandCancelled(signal)
  throwIfRobotMotionBlocked(robotId)
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2
}

function getJointAnglesForRobot(robotId: string | undefined): JointAngles {
  const robotStore = useRobotStore.getState()

  if (!robotId) {
    return [...robotStore.jointAngles] as JointAngles
  }

  return [...(robotStore.jointAnglesByRobotId[robotId] ?? robotStore.jointAngles)] as JointAngles
}

function setJointAnglesForCommandRobot(robotId: string | undefined, angles: JointAngles): void {
  const robotStore = useRobotStore.getState()

  if (robotId) {
    robotStore.setJointAnglesForRobot(robotId, angles)
    return
  }

  robotStore.setJointAngles(angles)
}

function syncGlobalPlayingState(): void {
  const store = useRobotStore.getState()
  const hasRunningRobot = Object.values(store.robotExecutionById).some(
    (execution) => execution.isPlaying
  )

  store.setPlaying(hasRunningRobot)
}

function normalizeDurationOverride(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function setBackendRobotPlaying(robotId: string, isPlaying: boolean, lastError?: string): void {
  const store = useRobotStore.getState()

  store.setRobotExecution(robotId, {
    isPlaying,
    ...(isPlaying ? { startedAt: new Date().toISOString() } : {}),
    ...(lastError !== undefined ? { lastError } : {})
  })

  syncGlobalPlayingState()
}

function setBackendRobotStepIndex(robotId: string | undefined, index: number): void {
  const store = useRobotStore.getState()

  if (!robotId?.trim()) {
    store.setCurrentStepIndex(index)
    return
  }

  store.setRobotExecution(robotId, {
    currentStepIndex: index
  })

  if (store.selectedRobotId === robotId) {
    store.setCurrentStepIndex(index)
  }
}

function parseMoveJPayload(payload: unknown): MoveJPayload {
  if (!isRecord(payload)) {
    throw new Error('MoveJ payload must be an object')
  }

  const jointAngles = payload.jointAngles

  if (!Array.isArray(jointAngles)) {
    throw new Error('MoveJ jointAngles must be an array')
  }

  if (jointAngles.length !== 6) {
    throw new Error('MoveJ jointAngles must contain exactly 6 values')
  }

  if (!jointAngles.every(isFiniteNumber)) {
    throw new Error('Every MoveJ joint angle must be a finite number')
  }

  validateMotionValue(payload.speed, 'speed')
  validateMotionValue(payload.acc, 'acc')

  return {
    jointAngles,
    speed: payload.speed as number | undefined,
    acc: payload.acc as number | undefined
  }
}

function parseMoveLPayload(payload: unknown): MoveLPayload {
  if (!isRecord(payload)) {
    throw new Error('MoveL payload must be an object')
  }

  if (!isRecord(payload.tcpPose)) {
    throw new Error('MoveL tcpPose must be an object')
  }

  const tcpPose = payload.tcpPose
  const requiredFields = ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const

  for (const field of requiredFields) {
    if (!isFiniteNumber(tcpPose[field])) {
      throw new Error(`MoveL tcpPose.${field} must be a finite number`)
    }
  }

  validateMotionValue(payload.speed, 'speed')
  validateMotionValue(payload.acc, 'acc')

  return {
    tcpPose: {
      x: tcpPose.x as number,
      y: tcpPose.y as number,
      z: tcpPose.z as number,
      rx: tcpPose.rx as number,
      ry: tcpPose.ry as number,
      rz: tcpPose.rz as number
    },
    speed: payload.speed as number | undefined,
    acc: payload.acc as number | undefined
  }
}

function parseRotateJointPayload(payload: unknown): RotateJointPayload {
  if (!isRecord(payload)) {
    throw new Error('RotateJoint payload must be an object')
  }

  if (
    !Number.isInteger(payload.jointIndex) ||
    (payload.jointIndex as number) < 0 ||
    (payload.jointIndex as number) > 5
  ) {
    throw new Error('RotateJoint jointIndex must be between 0 and 5')
  }

  if (!isFiniteNumber(payload.angle)) {
    throw new Error('RotateJoint angle must be a finite number')
  }

  validateMotionValue(payload.speed, 'speed')
  validateMotionValue(payload.acc, 'acc')

  return {
    jointIndex: payload.jointIndex as number,
    angle: payload.angle,
    speed: payload.speed as number | undefined,
    acc: payload.acc as number | undefined
  }
}

function parseSetDOPayload(payload: unknown): SetDOPayload {
  if (!isRecord(payload)) {
    throw new Error('SetDO payload must be an object')
  }

  if (payload.doType !== 'cabinet' && payload.doType !== 'tool') {
    throw new Error('SetDO doType must be cabinet or tool')
  }

  if (!Number.isInteger(payload.doIndex)) {
    throw new Error('SetDO doIndex must be an integer')
  }

  const doIndex = payload.doIndex as number

  if (payload.doType === 'cabinet' && (doIndex < 1 || doIndex > 8)) {
    throw new Error('Cabinet DO index must be between 1 and 8')
  }

  if (payload.doType === 'tool' && (doIndex < 0 || doIndex > 1)) {
    throw new Error('Tool DO index must be between 0 and 1')
  }

  if (payload.doValue !== 0 && payload.doValue !== 1) {
    throw new Error('SetDO doValue must be 0 or 1')
  }

  return {
    doType: payload.doType,
    doIndex,
    doValue: payload.doValue
  }
}

function parseRunProgramSteps(payload: unknown): RunProgramStep[] {
  if (!isRecord(payload)) {
    throw new Error('RunProgram payload must be an object')
  }

  if (!Array.isArray(payload.steps) || payload.steps.length === 0) {
    throw new Error('RunProgram steps must be a non-empty array')
  }

  const orderIndexes = new Set<number>()

  const steps = payload.steps.map((value, index): RunProgramStep => {
    if (!isRecord(value)) {
      throw new Error(`RunProgram step ${index + 1} must be an object`)
    }

    if (!Number.isInteger(value.orderIndex) || (value.orderIndex as number) < 1) {
      throw new Error(`RunProgram step ${index + 1} has invalid orderIndex`)
    }

    const orderIndex = value.orderIndex as number

    if (orderIndexes.has(orderIndex)) {
      throw new Error(`Duplicate RunProgram orderIndex: ${orderIndex}`)
    }

    orderIndexes.add(orderIndex)

    if (typeof value.stepType !== 'string' || !value.stepType.trim()) {
      throw new Error(`RunProgram step ${orderIndex} requires stepType`)
    }

    return {
      orderIndex,
      stepType: value.stepType,
      label: typeof value.label === 'string' ? value.label : undefined,
      payload: value.payload
    }
  })

  return steps.sort((first, second) => first.orderIndex - second.orderIndex)
}

function parseFactoryRunArmPayload(payload: unknown): FactoryRunArmPayload | null {
  if (!isRecord(payload)) return null

  const factoryRunId = typeof payload.factoryRunId === 'string' ? payload.factoryRunId : ''
  const targetId = typeof payload.targetId === 'string' ? payload.targetId : ''
  const syncMode = typeof payload.syncMode === 'string' ? payload.syncMode : ''
  const failurePolicy =
    payload.failurePolicy === 'AbortExecutionGroup' ? 'AbortExecutionGroup' : 'IsolateTarget'

  if (!factoryRunId || !targetId || syncMode !== 'Barrier') {
    return null
  }

  return {
    factoryRunId,
    targetId,
    failurePolicy
  }
}

async function waitUntilScheduledStart(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  if (!isRecord(payload)) return
  if (typeof payload.scheduledStartAtUtc !== 'string') return

  const scheduledAt = Date.parse(payload.scheduledStartAtUtc)

  if (!Number.isFinite(scheduledAt)) return

  const now = Date.now()
  const delayMs = scheduledAt - now

  if (FACTORY_RUN_DEBUG) {
    console.debug('[FactoryRun] scheduled wait', {
      scheduledStartAtUtc: payload.scheduledStartAtUtc,
      nowUtc: new Date(now).toISOString(),
      delayMs: Math.round(delayMs)
    })
  }

  if (delayMs > 0) {
    await delay(delayMs, signal)
  }

  const readyAt = Date.now()
  const lateByMs = Math.max(0, readyAt - scheduledAt)

  if (lateByMs > FACTORY_RUN_MAX_STANDALONE_START_LATENESS_MS) {
    const reason =
      `Factory run missed its synchronized start by ${Math.round(lateByMs)} ms; ` +
      'all active commands were stopped to prevent timing skew.'

    console.error('[FactoryRun] synchronized start rejected', {
      scheduledStartAtUtc: payload.scheduledStartAtUtc,
      readyAtUtc: new Date(readyAt).toISOString(),
      lateByMs: Math.round(lateByMs)
    })

    if (robotId) {
      cancelActiveCommandForRobot(robotId, reason)
    }
    throwIfCommandCancelled(signal)
    throw new Error(reason)
  }

  if (delayMs <= 0 || lateByMs > 10) {
    console.warn('[FactoryRun] RunProgram arrived after scheduledStartAtUtc', {
      scheduledStartAtUtc: payload.scheduledStartAtUtc,
      readyAtUtc: new Date(readyAt).toISOString(),
      lateByMs: Math.round(lateByMs),
      toleratedLateStart: true
    })
  }

  assertMotionCanContinue(signal, robotId)
}

async function waitForFactoryRunBarrierStart(
  armPayload: FactoryRunArmPayload,
  estimatedStepDurationsMs: number[],
  context: BackendCommandExecutionContext | undefined,
  signal: AbortSignal,
  robotId?: string
): Promise<FactoryRunArmResponse> {
  if (!context?.armFactoryRunCommand) {
    throw new Error('FactoryRun barrier arm API is not available in command executor context.')
  }

  for (let attempt = 0; attempt < FACTORY_RUN_ARM_MAX_ATTEMPTS; attempt++) {
    assertMotionCanContinue(signal, robotId)

    const armPollStartedAtMonotonicMs = performance.now()

    let response: FactoryRunArmResponse

    try {
      response = await context.armFactoryRunCommand(armPayload, estimatedStepDurationsMs, signal)
    } catch (error) {
      if (signal.aborted) {
        throwIfCommandCancelled(signal)
      }

      throw error
    }

    recordFactoryRunDiagnostic('robot.arm.poll', {
      factoryRunId: armPayload.factoryRunId,
      targetId: armPayload.targetId,
      durationMs: performance.now() - armPollStartedAtMonotonicMs,
      details: {
        attempt: attempt + 1,
        ready: response.isReady
      }
    })

    if (response.isReady && response.scheduledStartAtUtc) {
      return response
    }

    await delay(FACTORY_RUN_ARM_POLL_INTERVAL_MS, signal)
  }

  throw new Error('FactoryRun barrier start timed out while waiting for all robots to arm.')
}

async function executeWaitMs(
  payload: unknown,
  signal: AbortSignal,
  durationOverrideMs?: number,
  robotId?: string
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  if (!isRecord(payload)) {
    throw new Error('WaitMs payload must be an object')
  }

  const delayMs = payload.delayMs

  if (!Number.isInteger(delayMs) || (delayMs as number) < 0) {
    throw new Error('WaitMs delayMs must be a non-negative integer')
  }

  const finalDelayMs = normalizeDurationOverride(durationOverrideMs) ?? (delayMs as number)

  await delay(finalDelayMs, signal)
  assertMotionCanContinue(signal, robotId)
}

async function prepareRunProgramExecution(
  steps: RunProgramStep[],
  robotId: string | undefined,
  signal: AbortSignal
): Promise<PreparedRunProgramExecution> {
  const normalizedRobotId = robotId?.trim()

  if (!normalizedRobotId) {
    throw new Error('FactoryRun requires a robot ID before program preparation.')
  }

  const estimatedStepDurationsMs: number[] = []
  const moveLTrajectoriesByStepIndex = new Map<number, PreparedMoveLTrajectory>()

  // This state is advanced virtually while planning.
  // The real robot store is not changed during this phase.
  let plannedAngles = getJointAnglesForRobot(normalizedRobotId)

  for (let index = 0; index < steps.length; index++) {
    assertMotionCanContinue(signal, normalizedRobotId)

    const step = steps[index]

    try {
      switch (step.stepType) {
        case 'MoveJ': {
          const moveJ = parseMoveJPayload(step.payload)
          const targetAngles = [...moveJ.jointAngles] as JointAngles

          const maxDelta = Math.max(
            ...targetAngles.map((target, jointIndex) =>
              Math.abs(target - plannedAngles[jointIndex])
            )
          )

          const speedPercent = clamp(moveJ.speed ?? 30, 1, 100)

          estimatedStepDurationsMs.push(
            Math.round(clamp(800 + maxDelta * 18 * (30 / speedPercent), 800, 8000))
          )

          plannedAngles = [...targetAngles] as JointAngles
          break
        }

        case 'RotateJoint': {
          const rotateJoint = parseRotateJointPayload(step.payload)
          const targetAngles = [...plannedAngles] as JointAngles

          const maxDelta = Math.abs(rotateJoint.angle - targetAngles[rotateJoint.jointIndex])

          targetAngles[rotateJoint.jointIndex] = rotateJoint.angle

          const speedPercent = clamp(rotateJoint.speed ?? 30, 1, 100)

          estimatedStepDurationsMs.push(
            Math.round(clamp(800 + maxDelta * 18 * (30 / speedPercent), 800, 8000))
          )

          plannedAngles = targetAngles
          break
        }

        case 'MoveL':
        case 'MoveTCP': {
          const moveL = parseMoveLPayload(step.payload)
          const speedPercent = clamp(moveL.speed ?? 30, 1, 100)

          const trajectory = await prepareMoveLForRobot(
            normalizedRobotId,
            moveL.tcpPose,
            speedPercent,
            plannedAngles,
            signal
          )

          if (trajectory.keyframes.length < 2) {
            throw new Error(
              `Prepared ${step.stepType} trajectory does not contain motion keyframes.`
            )
          }

          moveLTrajectoriesByStepIndex.set(index, trajectory)

          plannedAngles = [...trajectory.keyframes[trajectory.keyframes.length - 1]] as JointAngles

          const baseDurationMs = clamp(6000 * (30 / speedPercent), 3000, 12000)

          // Give the scheduler enough time to sample dense IK trajectories.
          const trajectoryDurationFloorMs = trajectory.waypointCount * 16

          estimatedStepDurationsMs.push(
            Math.round(Math.max(baseDurationMs, trajectoryDurationFloorMs))
          )

          break
        }

        case 'WaitMs': {
          if (!isRecord(step.payload)) {
            throw new Error('WaitMs payload must be an object')
          }

          const delayMs = step.payload.delayMs

          if (!Number.isInteger(delayMs) || (delayMs as number) < 0) {
            throw new Error('WaitMs delayMs must be a non-negative integer')
          }

          estimatedStepDurationsMs.push(delayMs as number)
          break
        }

        case 'SetDO':
          estimatedStepDurationsMs.push(100)
          break

        case 'GripperOpen':
        case 'GripperClose':
          estimatedStepDurationsMs.push(500)
          break

        case 'Comment':
          estimatedStepDurationsMs.push(0)
          break

        default:
          throw new Error(`Unsupported RunProgram step type during preparation: ${step.stepType}`)
      }
    } catch (error) {
      if (error instanceof CommandExecutionError) {
        throw error
      }

      const technicalMessage =
        error instanceof Error ? error.message : 'RunProgram preparation failed'

      throw new CommandExecutionError(technicalMessage, {
        source: 'RunProgramPreparation',
        stepIndex: index + 1,
        stepOrderIndex: step.orderIndex,
        stepType: step.stepType,
        stepLabel: step.label,
        technicalMessage
      })
    }
  }

  assertMotionCanContinue(signal, normalizedRobotId)

  return {
    estimatedStepDurationsMs,
    moveLTrajectoriesByStepIndex
  }
}

async function executeRunProgram(
  payload: unknown,
  signal: AbortSignal,
  robotId: string | undefined,
  context?: BackendCommandExecutionContext
): Promise<void> {
  const steps = parseRunProgramSteps(payload)
  const armPayload = parseFactoryRunArmPayload(payload)

  let barrierResponse: FactoryRunArmResponse | null = null
  let preparedProgramExecution: PreparedRunProgramExecution | null = null
  let stepStartedAtMonotonicMs: number | undefined
  let runCompletedSuccessfully = false

  try {
    if (armPayload) {
      const robotPreparationStartedAtMonotonicMs = performance.now()

      recordFactoryRunDiagnostic('robot.prepare.started', {
        factoryRunId: armPayload.factoryRunId,
        robotId,
        targetId: armPayload.targetId,
        details: {
          stepCount: steps.length
        }
      })

      try {
        preparedProgramExecution = await prepareRunProgramExecution(steps, robotId, signal)
      } catch (error) {
        recordFactoryRunDiagnostic('robot.prepare.failed', {
          factoryRunId: armPayload.factoryRunId,
          robotId,
          targetId: armPayload.targetId,
          durationMs: performance.now() - robotPreparationStartedAtMonotonicMs,
          details: {
            reasonCode: 'program_preparation_failed'
          }
        })

        throw error
      }

      recordFactoryRunDiagnostic('robot.prepare.completed', {
        factoryRunId: armPayload.factoryRunId,
        robotId,
        targetId: armPayload.targetId,
        durationMs: performance.now() - robotPreparationStartedAtMonotonicMs,
        details: {
          stepCount: steps.length,
          moveLStepCount: preparedProgramExecution.moveLTrajectoriesByStepIndex.size
        }
      })

      barrierResponse = await waitForFactoryRunBarrierStart(
        armPayload,
        preparedProgramExecution.estimatedStepDurationsMs,
        context,
        signal,
        robotId
      )

      const scheduledStartAtUtc = barrierResponse.scheduledStartAtUtc

      if (!scheduledStartAtUtc) {
        throw new Error('Factory run barrier became ready without a synchronized start timestamp.')
      }

      const cohortJoinedAtMonotonicMs = performance.now()

      recordFactoryRunDiagnostic('robot.cohort.joined', {
        factoryRunId: armPayload.factoryRunId,
        robotId,
        targetId: armPayload.targetId,
        details: {
          expectedParticipantCount: barrierResponse.expectedParticipantCount
        }
      })

      stepStartedAtMonotonicMs = await factoryRunLocalStartBarrier.waitForStart(
        armPayload.factoryRunId,
        armPayload.targetId,
        scheduledStartAtUtc,
        barrierResponse.expectedParticipantCount,
        signal,
        armPayload.failurePolicy
      )

      recordFactoryRunDiagnostic('robot.cohort.released', {
        factoryRunId: armPayload.factoryRunId,
        robotId,
        targetId: armPayload.targetId,
        durationMs: performance.now() - cohortJoinedAtMonotonicMs,
        details: {
          expectedParticipantCount: barrierResponse.expectedParticipantCount
        }
      })
    } else {
      await waitUntilScheduledStart(payload, signal, robotId)
    }

    const sharedStepDurationsMs = Array.isArray(barrierResponse?.stepDurationsMs)
      ? barrierResponse.stepDurationsMs
      : []

    const preparedMoveLTrajectoriesByStepIndex =
      preparedProgramExecution?.moveLTrajectoriesByStepIndex ??
      new Map<number, PreparedMoveLTrajectory>()

    if (FACTORY_RUN_DEBUG && armPayload) {
      console.debug('[FactoryRun] program prepared before synchronized start', {
        robotId,
        factoryRunId: armPayload.factoryRunId,
        preparedMoveLStepCount: preparedMoveLTrajectoriesByStepIndex.size,
        estimatedStepDurationsMs: preparedProgramExecution?.estimatedStepDurationsMs ?? [],
        sharedStepDurationsMs
      })
    }

    const actualStartedAtUtc = new Date().toISOString()

    recordFactoryRunDiagnostic('robot.run.started', {
      factoryRunId: armPayload?.factoryRunId ?? null,
      robotId,
      targetId: armPayload?.targetId,
      details: {
        barrier: Boolean(armPayload)
      }
    })

    setBackendRobotPlaying(robotId ?? '', true, '')

    // Start metrics must not delay the first motion frame.
    if (armPayload && context?.reportFactoryRunStarted) {
      void context
        .reportFactoryRunStarted(armPayload, actualStartedAtUtc, signal)
        .catch((error) => {
          if (FACTORY_RUN_DEBUG) {
            console.warn('[FactoryRun] actual-start report failed', {
              robotId,
              actualStartedAtUtc,
              error
            })
          }
        })
    }

    if (FACTORY_RUN_DEBUG) {
      console.debug('[FactoryRun] RunProgram started', {
        robotId,
        startedAtUtc: actualStartedAtUtc,
        barrier: Boolean(armPayload)
      })
    }

    for (let index = 0; index < steps.length; index++) {
      assertMotionCanContinue(signal, robotId)

      const step = steps[index]
      const stepStartedAtDiagnosticMs = performance.now()

      recordFactoryRunDiagnostic('robot.step.started', {
        factoryRunId: armPayload?.factoryRunId ?? null,
        robotId,
        targetId: armPayload?.targetId,
        stepIndex: index,
        details: {
          orderIndex: step.orderIndex,
          stepType: step.stepType
        }
      })
      const sharedDurationMs = normalizeDurationOverride(sharedStepDurationsMs[index])

      setBackendRobotStepIndex(robotId, index)

      try {
        const requiresSharedMotionDuration =
          step.stepType === 'MoveJ' ||
          step.stepType === 'MoveL' ||
          step.stepType === 'MoveTCP' ||
          step.stepType === 'RotateJoint'

        if (armPayload && requiresSharedMotionDuration && sharedDurationMs === undefined) {
          throw new Error(
            `FactoryRun step ${step.orderIndex} (${step.stepType}) ` +
              `does not have a shared motion duration.`
          )
        }

        switch (step.stepType) {
          case 'MoveJ':
            await executeMoveJ(
              step.payload,
              signal,
              robotId,
              sharedDurationMs,
              stepStartedAtMonotonicMs
            )
            break

          case 'MoveL': {
            const preparedTrajectory = preparedMoveLTrajectoriesByStepIndex.get(index)

            if (armPayload && !preparedTrajectory) {
              throw new Error(
                `FactoryRun MoveL step ${step.orderIndex} ` + `does not have a prepared trajectory.`
              )
            }

            await executeMoveL(
              step.payload,
              signal,
              robotId,
              sharedDurationMs,
              stepStartedAtMonotonicMs,
              preparedTrajectory
            )
            break
          }
          case 'RotateJoint':
            await executeRotateJoint(
              step.payload,
              signal,
              robotId,
              sharedDurationMs,
              stepStartedAtMonotonicMs
            )
            break

          case 'MoveTCP': {
            const preparedTrajectory = preparedMoveLTrajectoriesByStepIndex.get(index)

            if (armPayload && !preparedTrajectory) {
              throw new Error(
                `FactoryRun MoveTCP step ${step.orderIndex} ` +
                  `does not have a prepared trajectory.`
              )
            }

            await executeMoveTCP(
              step.payload,
              signal,
              robotId,
              sharedDurationMs,
              stepStartedAtMonotonicMs,
              preparedTrajectory
            )
            break
          }

          case 'WaitMs':
            await executeWaitMs(step.payload, signal, sharedDurationMs, robotId)
            break

          case 'SetDO':
            await executeSetDO(step.payload, signal, robotId)
            break

          case 'GripperOpen':
            await executeGripper('open', signal, robotId)
            break

          case 'GripperClose':
            await executeGripper('closed', signal, robotId)
            break

          case 'Comment':
            break

          default:
            throw new Error(`Unsupported RunProgram step type: ${step.stepType}`)
        }
        assertMotionCanContinue(signal, robotId)
        recordFactoryRunDiagnostic('robot.step.completed', {
          factoryRunId: armPayload?.factoryRunId ?? null,
          robotId,
          targetId: armPayload?.targetId,
          stepIndex: index,
          durationMs: performance.now() - stepStartedAtDiagnosticMs,
          details: {
            orderIndex: step.orderIndex,
            stepType: step.stepType
          }
        })

        if (armPayload) {
          const stepBarrierResult = await factoryRunStepCoordinator.arriveAtStep({
            factoryRunId: armPayload.factoryRunId,
            participantId: armPayload.targetId,
            stepIndex: index,
            completedAtMonotonicMs: performance.now(),
            signal
          })
          stepStartedAtMonotonicMs = stepBarrierResult.nextStepStartedAtMonotonicMs

          if (FACTORY_RUN_DEBUG) {
            console.debug('[FactoryRun] step barrier released', {
              factoryRunId: armPayload.factoryRunId,
              targetId: armPayload.targetId,
              robotId,
              stepIndex: index,
              stepOrderIndex: step.orderIndex,
              participantCount: stepBarrierResult.participantCount,
              completionSkewMs: Math.round(stepBarrierResult.completionSkewMs),
              nextStepStartedAtMonotonicMs: stepBarrierResult.nextStepStartedAtMonotonicMs
            })
          }
        }
      } catch (error) {
        if (error instanceof CommandExecutionError) {
          throw error
        }

        const technicalMessage =
          error instanceof Error ? error.message : 'RunProgram step execution failed'

        throw new CommandExecutionError(technicalMessage, {
          source: 'RunProgram',
          stepIndex: index + 1,
          stepOrderIndex: step.orderIndex,
          stepType: step.stepType,
          stepLabel: step.label,
          technicalMessage
        })
      }
    }

    assertMotionCanContinue(signal, robotId)
    recordFactoryRunDiagnostic('robot.run.completed', {
      factoryRunId: armPayload?.factoryRunId ?? null,
      robotId,
      targetId: armPayload?.targetId,
      details: {
        stepCount: steps.length
      }
    })
    runCompletedSuccessfully = true
  } catch (error) {
    if (armPayload) {
      const coordinatorError =
        error instanceof Error ? error : new Error('Factory run execution failed.')
      const reason = `Factory run ${armPayload.factoryRunId}: ${coordinatorError.message}`

      if (armPayload.failurePolicy === 'IsolateTarget') {
        factoryRunLocalStartBarrier.dropParticipant(
          armPayload.factoryRunId,
          armPayload.targetId,
          reason
        )
        const activeParticipantCount = factoryRunStepCoordinator.dropParticipant(
          armPayload.factoryRunId,
          armPayload.targetId,
          coordinatorError
        )

        if (robotId) {
          cancelActiveCommandForRobot(robotId, reason)
        }

        recordFactoryRunDiagnostic('robot.participant.dropped', {
          factoryRunId: armPayload.factoryRunId,
          robotId,
          targetId: armPayload.targetId,
          details: {
            activeParticipantCount,
            failurePolicy: armPayload.failurePolicy
          }
        })
      } else {
        factoryRunStepCoordinator.abortRun(armPayload.factoryRunId, coordinatorError)
        cancelActiveCommandsForGroup(armPayload.factoryRunId, reason)
      }
    }
    recordFactoryRunDiagnostic('robot.run.failed', {
      factoryRunId: armPayload?.factoryRunId ?? null,
      robotId,
      targetId: armPayload?.targetId,
      details: {
        reasonCode: 'command_execution_failed'
      }
    })

    throw error
  } finally {
    if (armPayload && runCompletedSuccessfully) {
      factoryRunStepCoordinator.completeParticipant(armPayload.factoryRunId, armPayload.targetId)
    }
  }
}

async function executeMoveJ(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string,
  durationOverrideMs?: number,
  startedAtMonotonicMs?: number
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  const moveJ = parseMoveJPayload(payload)
  const startAngles = getJointAnglesForRobot(robotId)
  const targetAngles = [...moveJ.jointAngles]

  const maxDelta = Math.max(
    ...targetAngles.map((target, index) => Math.abs(target - startAngles[index]))
  )

  const speedPercent = moveJ.speed ?? 30
  const estimatedDurationMs = clamp(800 + maxDelta * 18 * (30 / speedPercent), 800, 8000)
  const durationMs = normalizeDurationOverride(durationOverrideMs) ?? estimatedDurationMs

  if (FACTORY_RUN_DEBUG) {
    console.debug('[FactoryRun] MoveJ timing', {
      robotId,
      maxDelta,
      speedPercent,
      estimatedDurationMs: Math.round(estimatedDurationMs),
      durationMs: Math.round(durationMs),
      usingSharedDuration: normalizeDurationOverride(durationOverrideMs) !== undefined
    })
  }
  if (robotId?.trim()) {
    await runScheduledJointMotion(
      robotId,
      startAngles,
      targetAngles as JointAngles,
      durationMs,
      signal,
      easeInOutCubic,
      startedAtMonotonicMs
    )
  } else {
    // Giữ hành vi cũ cho command không gắn robot cụ thể.
    const startedAt = performance.now()

    while (true) {
      assertMotionCanContinue(signal, robotId)

      const now = performance.now()
      const rawProgress = (now - startedAt) / durationMs
      const progress = clamp(rawProgress, 0, 1)
      const easedProgress = easeInOutCubic(progress)

      const interpolated = startAngles.map((start, index) => {
        const target = targetAngles[index]
        return start + (target - start) * easedProgress
      }) as JointAngles

      setJointAnglesForCommandRobot(robotId, interpolated)

      if (progress >= 1) {
        break
      }

      await waitForAnimationFrame(signal)
    }
  }

  setJointAnglesForCommandRobot(robotId, targetAngles as JointAngles)

  assertMotionCanContinue(signal, robotId)

  setJointAnglesForCommandRobot(robotId, targetAngles as JointAngles)

  assertMotionCanContinue(signal, robotId)
}

async function executeRotateJoint(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string,
  durationOverrideMs?: number,
  startedAtMonotonicMs?: number
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  const rotateJoint = parseRotateJointPayload(payload)
  const targetAngles = getJointAnglesForRobot(robotId)

  targetAngles[rotateJoint.jointIndex] = rotateJoint.angle

  await executeMoveJ(
    {
      jointAngles: targetAngles,
      speed: rotateJoint.speed,
      acc: rotateJoint.acc
    },
    signal,
    robotId,
    durationOverrideMs,
    startedAtMonotonicMs
  )
}

async function executeMoveL(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string,
  durationOverrideMs?: number,
  startedAtMonotonicMs?: number,
  preparedTrajectory?: PreparedMoveLTrajectory
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  const moveL = parseMoveLPayload(payload)

  if (robotId?.trim()) {
    await runMoveLForRobot(robotId, moveL.tcpPose, moveL.speed ?? 30, signal, {
      managePlayingState: false,
      durationMs: durationOverrideMs,
      startedAtMonotonicMs,
      preparedTrajectory
    })
  } else {
    if (preparedTrajectory) {
      throw new Error('Prepared MoveL trajectory requires a robot-specific runner.')
    }

    await runMoveL(moveL.tcpPose, moveL.speed ?? 30, signal, {
      managePlayingState: false,
      durationMs: durationOverrideMs,
      startedAtMonotonicMs
    })
  }

  assertMotionCanContinue(signal, robotId)
}

async function executeMoveTCP(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string,
  durationOverrideMs?: number,
  startedAtMonotonicMs?: number,
  preparedTrajectory?: PreparedMoveLTrajectory
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  await executeMoveL(
    payload,
    signal,
    robotId,
    durationOverrideMs,
    startedAtMonotonicMs,
    preparedTrajectory
  )
}
async function executeSetDO(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  const setDO = parseSetDOPayload(payload)

  useRobotStore.getState().setDigitalOutput(setDO.doType, setDO.doIndex, setDO.doValue)

  await delay(100, signal)
  assertMotionCanContinue(signal, robotId)
}

async function executeGripper(
  state: 'open' | 'closed',
  signal: AbortSignal,
  robotId?: string
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  const robotStore = useRobotStore.getState()
  const doValue: 0 | 1 = state === 'closed' ? 1 : 0

  robotStore.setDigitalOutput('cabinet', 1, doValue)
  robotStore.setGripperState(state)

  await delay(500, signal)
  assertMotionCanContinue(signal, robotId)
}

function executeEmergencyStop(robotId: string, commandId: string): void {
  cancelActiveCommandForRobot(robotId, `Emergency stop requested by command ${commandId}`)

  const store = useRobotStore.getState()

  store.setRobotExecution(robotId, {
    isPlaying: false,
    currentStepIndex: 0
  })

  syncGlobalPlayingState()
}
export async function executeBackendCommand(
  command: PendingDeviceCommand,
  context?: BackendCommandExecutionContext
): Promise<void> {
  if (command.commandType === 'EStop') {
    executeEmergencyStop(command.robotId, command.commandId)
    return
  }

  const factoryRunPayload =
    command.commandType === 'RunProgram' ? parseFactoryRunArmPayload(command.payload) : null
  const signal = beginCommandExecutionForRobot(
    command.robotId,
    command.commandId,
    factoryRunPayload?.factoryRunId
  )

  if (command.commandType !== 'RunProgram') {
    setBackendRobotPlaying(command.robotId, true, '')
  }

  try {
    assertMotionCanContinue(signal, command.robotId)

    switch (command.commandType) {
      case 'PrepareProgram':
        await delay(200, signal)
        break

      case 'SetDO':
        await executeSetDO(command.payload, signal, command.robotId)
        break

      case 'MoveJ':
        await executeMoveJ(command.payload, signal, command.robotId)
        break

      case 'MoveL':
        await executeMoveL(command.payload, signal, command.robotId)
        break

      case 'RunProgram':
        await executeRunProgram(command.payload, signal, command.robotId, context)
        break

      default:
        throw new Error(`Unsupported command type: ${command.commandType}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backend command execution failed'

    useRobotStore.getState().setRobotExecution(command.robotId, {
      lastError: message
    })

    if (!(error instanceof CommandExecutionCancelledError)) {
      latchRobotFault(command.robotId, {
        kind: 'command',
        code: 'COMMAND_EXECUTION_FAILED',
        message,
        cancelMotion: false
      })
    }

    throw error
  } finally {
    setBackendRobotPlaying(command.robotId, false)

    finishCommandExecutionForRobot(command.robotId, command.commandId)
  }
}
