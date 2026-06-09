import { useRobotStore } from '../store/robotStore'
import { JointAngles, TCPPose } from '../types/robot.types'
import { PendingDeviceCommand } from '../types/backendDevice'
import { runMoveL } from './robotMotionRuntime'

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
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

async function executeMoveJ(payload: unknown): Promise<void> {
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
      const progress = easeInOutCubic(frame / frameCount)
      const interpolated = startAngles.map((start, index) => {
        const target = targetAngles[index]
        return start + (target - start) * progress
      }) as JointAngles

      useRobotStore.getState().setJointAngles(interpolated)
      await delay(frameMs)
    }

    useRobotStore.getState().setJointAngles(targetAngles as JointAngles)
  } finally {
    useRobotStore.getState().setPlaying(false)
  }
}

async function executeMoveL(payload: unknown): Promise<void> {
  const moveL = parseMoveLPayload(payload)

  await runMoveL(moveL.tcpPose, moveL.speed ?? 30)
}

export async function executeBackendCommand(command: PendingDeviceCommand): Promise<void> {
  switch (command.commandType) {
    case 'MoveJ':
      await executeMoveJ(command.payload)
      return

    case 'MoveL':
      await executeMoveL(command.payload)
      return

    default:
      throw new Error(`Unsupported command type: ${command.commandType}`)
  }
}
