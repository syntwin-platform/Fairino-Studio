import type { JointAngles, TCPPose, WorkflowStep } from '../../types/robot.types'

export interface ProgramJsonDiagnostic {
  path: string
  message: string
}

export interface ProgramJsonParseResult {
  projectName: string
  steps: WorkflowStep[]
  diagnostics: ProgramJsonDiagnostic[]
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNumber(value: unknown, name: string, min?: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`)
  }

  if (min !== undefined && value < min) {
    throw new Error(`${name} must be at least ${min}.`)
  }

  if (max !== undefined && value > max) {
    throw new Error(`${name} must not exceed ${max}.`)
  }

  return value
}

function requirePercent(value: unknown, name: string): number {
  return requireNumber(value, name, 1, 100)
}

function parseTcpPose(value: unknown): TCPPose {
  if (!isObject(value)) {
    throw new Error('tcpPose must be an object.')
  }

  return {
    x: requireNumber(value.x, 'tcpPose.x'),
    y: requireNumber(value.y, 'tcpPose.y'),
    z: requireNumber(value.z, 'tcpPose.z'),
    rx: requireNumber(value.rx, 'tcpPose.rx'),
    ry: requireNumber(value.ry, 'tcpPose.ry'),
    rz: requireNumber(value.rz, 'tcpPose.rz')
  }
}

function parseStep(
  value: unknown,
  arrayIndex: number,
  diagnostics: ProgramJsonDiagnostic[]
): { orderIndex: number; step: WorkflowStep } | null {
  const path = `steps[${arrayIndex}]`

  try {
    if (!isObject(value)) {
      throw new Error('Step must be an object.')
    }

    const orderIndex = requireNumber(value.orderIndex, 'orderIndex', 1)

    if (!Number.isInteger(orderIndex)) {
      throw new Error('orderIndex must be an integer.')
    }

    if (typeof value.stepType !== 'string') {
      throw new Error('stepType must be a string.')
    }

    if (!isObject(value.payload)) {
      throw new Error('payload must be an object.')
    }

    const payload = value.payload
    const type = value.stepType
    const label =
      typeof value.label === 'string' && value.label.trim()
        ? value.label.trim()
        : `${type} ${orderIndex}`

    const common = {
      id: `step_json_${orderIndex}`,
      label
    }

    switch (type) {
      case 'MoveJ': {
        if (!Array.isArray(payload.jointAngles) || payload.jointAngles.length !== 6) {
          throw new Error('MoveJ jointAngles must contain exactly 6 numbers.')
        }

        const jointAngles = payload.jointAngles.map((item, index) =>
          requireNumber(item, `jointAngles[${index}]`)
        ) as JointAngles

        return {
          orderIndex,
          step: {
            ...common,
            type: 'MoveJ',
            jointAngles,
            speed: requirePercent(payload.speed, 'speed'),
            acc: requirePercent(payload.acc, 'acc')
          }
        }
      }

      case 'MoveL':
      case 'MoveTCP':
        return {
          orderIndex,
          step: {
            ...common,
            type,
            tcpPose: parseTcpPose(payload.tcpPose),
            moveMode: type === 'MoveTCP' ? 'absolute' : undefined,
            speed: requirePercent(payload.speed, 'speed'),
            acc: requirePercent(payload.acc, 'acc')
          }
        }

      case 'RotateJoint': {
        const backendJointIndex = requireNumber(payload.jointIndex, 'jointIndex', 0, 5)

        if (!Number.isInteger(backendJointIndex)) {
          throw new Error('jointIndex must be an integer.')
        }

        return {
          orderIndex,
          step: {
            ...common,
            type: 'RotateJoint',
            jointIndex: backendJointIndex + 1,
            angle: requireNumber(payload.angle, 'angle'),
            rotateMode: 'absolute',
            speed: requirePercent(payload.speed, 'speed'),
            acc: requirePercent(payload.acc, 'acc')
          }
        }
      }

      case 'SetDO': {
        const doType = payload.doType

        if (doType !== 'cabinet' && doType !== 'tool') {
          throw new Error('doType must be cabinet or tool.')
        }

        const doIndex = requireNumber(
          payload.doIndex,
          'doIndex',
          doType === 'cabinet' ? 1 : 0,
          doType === 'cabinet' ? 8 : 1
        )

        if (!Number.isInteger(doIndex)) {
          throw new Error('doIndex must be an integer.')
        }

        if (payload.doValue !== 0 && payload.doValue !== 1) {
          throw new Error('doValue must be 0 or 1.')
        }

        return {
          orderIndex,
          step: {
            ...common,
            type: 'SetDO',
            doType,
            doIndex,
            doValue: payload.doValue,
            speed: 50,
            acc: 50
          }
        }
      }

      case 'WaitMs':
        return {
          orderIndex,
          step: {
            ...common,
            type: 'WaitMs',
            delayMs: requireNumber(payload.delayMs, 'delayMs', 0),
            speed: 50,
            acc: 50
          }
        }

      case 'GripperOpen':
      case 'GripperClose':
        return {
          orderIndex,
          step: {
            ...common,
            type,
            speed: 50,
            acc: 50
          }
        }

      case 'Comment':
        return {
          orderIndex,
          step: {
            ...common,
            type: 'Comment',
            comment: typeof payload.text === 'string' ? payload.text : label,
            speed: 50,
            acc: 50
          }
        }

      default:
        throw new Error(`Unsupported stepType: ${type}.`)
    }
  } catch (error) {
    diagnostics.push({
      path,
      message: error instanceof Error ? error.message : 'Invalid step.'
    })

    return null
  }
}

export function parseProgramJson(content: string): ProgramJsonParseResult {
  const diagnostics: ProgramJsonDiagnostic[] = []
  let document: unknown

  try {
    document = JSON.parse(content)
  } catch (error) {
    return {
      projectName: 'Imported JSON Program',
      steps: [],
      diagnostics: [
        {
          path: '$',
          message: error instanceof Error ? error.message : 'Invalid JSON.'
        }
      ]
    }
  }

  if (!isObject(document)) {
    return {
      projectName: 'Imported JSON Program',
      steps: [],
      diagnostics: [{ path: '$', message: 'Program must be an object.' }]
    }
  }

  const projectName =
    typeof document.name === 'string' && document.name.trim()
      ? document.name.trim()
      : 'Imported JSON Program'

  if (!Array.isArray(document.steps)) {
    return {
      projectName,
      steps: [],
      diagnostics: [{ path: 'steps', message: 'steps must be an array.' }]
    }
  }

  const parsedSteps = document.steps
    .map((step, index) => parseStep(step, index, diagnostics))
    .filter((item): item is NonNullable<typeof item> => item !== null)

  const usedIndexes = new Set<number>()

  for (const item of parsedSteps) {
    if (usedIndexes.has(item.orderIndex)) {
      diagnostics.push({
        path: 'steps',
        message: `Duplicate orderIndex: ${item.orderIndex}.`
      })
    }

    usedIndexes.add(item.orderIndex)
  }

  parsedSteps.sort((a, b) => a.orderIndex - b.orderIndex)

  return {
    projectName,
    steps: parsedSteps.map((item) => item.step),
    diagnostics
  }
}
