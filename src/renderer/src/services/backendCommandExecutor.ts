import { useRobotStore } from '../store/robotStore'
import { useSceneStore } from '../store/sceneStore'
import { JointAngles, TCPPose } from '../types/robot.types'
import { PendingDeviceCommand } from '../types/backendDevice'
import { runMoveL } from './robotMotionRuntime'
import {
  beginCommandExecution,
  cancelActiveCommand,
  finishCommandExecution,
  throwIfCommandCancelled
} from './commandExecutionRuntime'

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

function throwIfCollisionDetected(): void {
  if (!useSceneStore.getState().collisionWarning) {
    return
  }

  throw new Error('Collision detected. Robot motion stopped by Fairino Studio.')
}

function assertMotionCanContinue(signal: AbortSignal): void {
  throwIfCommandCancelled(signal)
  throwIfCollisionDetected()
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2
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

async function executeWaitMs(payload: unknown, signal: AbortSignal): Promise<void> {
  assertMotionCanContinue(signal)

  if (!isRecord(payload)) {
    throw new Error('WaitMs payload must be an object')
  }

  const delayMs = payload.delayMs

  if (!Number.isInteger(delayMs) || (delayMs as number) < 0) {
    throw new Error('WaitMs delayMs must be a non-negative integer')
  }

  await delay(delayMs as number, signal)
  assertMotionCanContinue(signal)
}

async function executeRunProgram(payload: unknown, signal: AbortSignal): Promise<void> {
  const steps = parseRunProgramSteps(payload)

  for (let index = 0; index < steps.length; index++) {
    assertMotionCanContinue(signal)

    const step = steps[index]

    useRobotStore.getState().setCurrentStepIndex(index)

    try {
      switch (step.stepType) {
        case 'MoveJ':
          await executeMoveJ(step.payload, signal)
          break

        case 'MoveL':
          await executeMoveL(step.payload, signal)
          break

        case 'RotateJoint':
          await executeRotateJoint(step.payload, signal)
          break

        case 'MoveTCP':
          await executeMoveTCP(step.payload, signal)
          break

        case 'WaitMs':
          await executeWaitMs(step.payload, signal)
          break

        case 'SetDO':
          await executeSetDO(step.payload, signal)
          break

        case 'GripperOpen':
          await executeGripper('open', signal)
          break

        case 'GripperClose':
          await executeGripper('closed', signal)
          break

        case 'Comment':
          break

        default:
          throw new Error(`Unsupported RunProgram step type: ${step.stepType}`)
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

  assertMotionCanContinue(signal)
}

async function executeMoveJ(payload: unknown, signal: AbortSignal): Promise<void> {
  assertMotionCanContinue(signal)

  const moveJ = parseMoveJPayload(payload)
  const robotStore = useRobotStore.getState()
  const startAngles = [...robotStore.jointAngles]
  const targetAngles = [...moveJ.jointAngles]
  const maxDelta = Math.max(
    ...targetAngles.map((target, index) => Math.abs(target - startAngles[index]))
  )
  const speedPercent = moveJ.speed ?? 30
  const durationMs = clamp(800 + maxDelta * 18 * (30 / speedPercent), 800, 8000)
  const frameMs = 1000 / 60
  const frameCount = Math.max(1, Math.ceil(durationMs / frameMs))

  robotStore.setPlaying(true)

  try {
    for (let frame = 1; frame <= frameCount; frame++) {
      assertMotionCanContinue(signal)

      const progress = easeInOutCubic(frame / frameCount)
      const interpolated = startAngles.map((start, index) => {
        const target = targetAngles[index]
        return start + (target - start) * progress
      }) as JointAngles

      useRobotStore.getState().setJointAngles(interpolated)
      await delay(frameMs, signal)
      assertMotionCanContinue(signal)
    }

    assertMotionCanContinue(signal)
    useRobotStore.getState().setJointAngles(targetAngles as JointAngles)
    assertMotionCanContinue(signal)
  } finally {
    useRobotStore.getState().setPlaying(false)
  }
}

async function executeRotateJoint(payload: unknown, signal: AbortSignal): Promise<void> {
  assertMotionCanContinue(signal)

  const rotateJoint = parseRotateJointPayload(payload)
  const targetAngles = [...useRobotStore.getState().jointAngles] as JointAngles

  targetAngles[rotateJoint.jointIndex] = rotateJoint.angle

  await executeMoveJ(
    {
      jointAngles: targetAngles,
      speed: rotateJoint.speed,
      acc: rotateJoint.acc
    },
    signal
  )
}

async function executeMoveL(payload: unknown, signal: AbortSignal): Promise<void> {
  assertMotionCanContinue(signal)

  const moveL = parseMoveLPayload(payload)

  await runMoveL(moveL.tcpPose, moveL.speed ?? 30, signal)

  assertMotionCanContinue(signal)
}

async function executeMoveTCP(payload: unknown, signal: AbortSignal): Promise<void> {
  assertMotionCanContinue(signal)

  // Backend snapshot đã chuyển MoveTCP thành TCP pose tuyệt đối.
  await executeMoveL(payload, signal)
}

async function executeSetDO(payload: unknown, signal: AbortSignal): Promise<void> {
  assertMotionCanContinue(signal)

  const setDO = parseSetDOPayload(payload)

  useRobotStore.getState().setDigitalOutput(setDO.doType, setDO.doIndex, setDO.doValue)

  await delay(100, signal)
  assertMotionCanContinue(signal)
}

async function executeGripper(state: 'open' | 'closed', signal: AbortSignal): Promise<void> {
  assertMotionCanContinue(signal)

  const robotStore = useRobotStore.getState()
  const doValue: 0 | 1 = state === 'closed' ? 1 : 0

  robotStore.setDigitalOutput('cabinet', 1, doValue)
  robotStore.setGripperState(state)

  await delay(500, signal)
  assertMotionCanContinue(signal)
}

function executeEmergencyStop(commandId: string): void {
  cancelActiveCommand(`Emergency stop requested by command ${commandId}`)

  // EStop giữ robot tại vị trí hiện tại và dừng trạng thái playback.
  useRobotStore.getState().setPlaying(false)
}

export async function executeBackendCommand(command: PendingDeviceCommand): Promise<void> {
  if (command.commandType === 'EStop') {
    executeEmergencyStop(command.commandId)
    return
  }

  const signal = beginCommandExecution(command.commandId)

  try {
    assertMotionCanContinue(signal)

    switch (command.commandType) {
      case 'SetDO':
        await executeSetDO(command.payload, signal)
        return

      case 'MoveJ':
        await executeMoveJ(command.payload, signal)
        return

      case 'MoveL':
        await executeMoveL(command.payload, signal)
        return

      case 'RunProgram':
        await executeRunProgram(command.payload, signal)
        return

      default:
        throw new Error(`Unsupported command type: ${command.commandType}`)
    }
  } finally {
    finishCommandExecution(command.commandId)
  }
}
