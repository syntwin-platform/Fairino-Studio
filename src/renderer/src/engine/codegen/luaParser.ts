import { JointAngles, TCPPose, WorkflowStep } from '../../types/robot.types'

export interface LuaParseDiagnostic {
  line: number
  severity: 'error' | 'warning'
  message: string
  source: string
}

export interface LuaParseResult {
  steps: WorkflowStep[]
  projectName: string
  diagnostics: LuaParseDiagnostic[]
}

const TO_DOUBLE_PATTERN =
  /toDouble\(\s*(['"])([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\1\s*\)/g

function normalizeNumbers(line: string): string {
  return line.replace(TO_DOUBLE_PATTERN, '$2')
}

function createStepId(index: number): string {
  return `step_imported_${index + 1}`
}

function parseNumber(value: string): number | null {
  const number = Number(value.trim())
  return Number.isFinite(number) ? number : null
}

function parseNumberList(value: string): number[] | null {
  const values = value.split(',').map(parseNumber)

  return values.every((item): item is number => item !== null) ? values : null
}

function isValidPercent(value: number): boolean {
  return value >= 1 && value <= 100
}

interface LuaTraceMetadata {
  trace: NonNullable<WorkflowStep['trace']>
  jointAngles: JointAngles
}

function parseTraceMetadata(value: string): LuaTraceMetadata | null {
  try {
    const metadata: unknown = JSON.parse(value)

    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null

    const record = metadata as Record<string, unknown>
    const jointAngles = record.jointAngles

    if (
      record.version !== 1 ||
      typeof record.groupId !== 'string' ||
      !record.groupId.trim() ||
      !Number.isInteger(record.sampleIndex) ||
      !Number.isInteger(record.sampleCount) ||
      (record.sampleIndex as number) < 0 ||
      (record.sampleCount as number) < 1 ||
      (record.sampleIndex as number) >= (record.sampleCount as number) ||
      typeof record.segmentDurationMs !== 'number' ||
      !Number.isFinite(record.segmentDurationMs) ||
      record.segmentDurationMs < 0 ||
      !Array.isArray(jointAngles) ||
      jointAngles.length !== 6 ||
      !jointAngles.every((angle) => typeof angle === 'number' && Number.isFinite(angle))
    ) {
      return null
    }

    return {
      trace: {
        groupId: record.groupId.trim(),
        sampleIndex: record.sampleIndex as number,
        sampleCount: record.sampleCount as number,
        segmentDurationMs: record.segmentDurationMs
      },
      jointAngles: jointAngles as JointAngles
    }
  } catch {
    return null
  }
}

export function parseLua(luaContent: string): LuaParseResult {
  const steps: WorkflowStep[] = []
  const diagnostics: LuaParseDiagnostic[] = []
  const lines = luaContent.replace(/\r\n/g, '\n').split('\n')

  let projectName = 'Imported Project'
  let currentLabel = ''
  let currentComment = ''
  let insideToDoubleHelper = false
  let gripperHint = false
  let currentTraceMetadata: LuaTraceMetadata | null = null

  const addError = (lineIndex: number, message: string, source: string): void => {
    diagnostics.push({
      line: lineIndex + 1,
      severity: 'error',
      message,
      source
    })
  }

  const addStep = (step: Omit<WorkflowStep, 'id'>): void => {
    steps.push({
      ...step,
      id: createStepId(steps.length)
    })

    currentLabel = ''
    currentComment = ''
    gripperHint = false
    currentTraceMetadata = null
  }

  for (let index = 0; index < lines.length; index++) {
    const source = lines[index]
    const line = source.trim()

    if (!line) continue

    const projectMatch = line.match(/^--\s*Project Name\s*:\s*(.+)$/i)

    if (projectMatch) {
      projectName = projectMatch[1].trim()
      continue
    }

    const stepLabelMatch = line.match(/^--\s*\[[^\]]*\d+\]\s*(.+)$/)

    if (stepLabelMatch) {
      currentLabel = stepLabelMatch[1].trim()
      currentComment = ''
      continue
    }

    const noteMatch = line.match(/^--\s*(?:Ghi\s+ch\S*|Note)\s*:\s*(.+)$/i)

    if (noteMatch) {
      currentComment = noteMatch[1].trim()
      continue
    }

    const traceMetadataMatch = line.match(/^--\s*@FAIROBOT_TRACE\s+(.+)$/)

    if (traceMetadataMatch) {
      currentTraceMetadata = parseTraceMetadata(traceMetadataMatch[1])

      if (!currentTraceMetadata) {
        addError(index, 'Invalid @FAIROBOT_TRACE metadata.', source)
      }

      continue
    }

    if (/^local\s+function\s+toDouble\s*\(/.test(line)) {
      insideToDoubleHelper = true
      continue
    }

    if (insideToDoubleHelper) {
      if (/^end\s*;?$/.test(line)) {
        insideToDoubleHelper = false
      }

      continue
    }

    if (line.startsWith('--')) {
      if (/tay\s+g|gripper/i.test(line)) {
        gripperHint = true
      }

      continue
    }

    const normalizedLine = normalizeNumbers(line)

    if (gripperHint) {
      const gripperMatch = normalizedLine.match(/^SetDO\(\s*1\s*,\s*([01])(?:\s*,.*)?\)\s*;?$/)

      const nextLine = index + 1 < lines.length ? normalizeNumbers(lines[index + 1].trim()) : ''

      if (gripperMatch && /^WaitMs\(\s*500\s*\)\s*;?$/.test(nextLine)) {
        const isClosed = gripperMatch[1] === '1'

        addStep({
          type: isClosed ? 'GripperClose' : 'GripperOpen',
          label: currentLabel || (isClosed ? 'Close gripper' : 'Open gripper'),
          comment: currentComment || undefined,
          speed: 50,
          acc: 50
        })

        index += 1
        continue
      }
    }

    const moveJMatch = normalizedLine.match(
      /^MoveJ\(\s*\{([^}]*)\}\s*,\s*[^,]+,\s*[^,]+,\s*([^,]+),\s*([^,]+)(?:,.*)?\)\s*;?$/
    )

    if (moveJMatch) {
      const joints = parseNumberList(moveJMatch[1])
      const speed = parseNumber(moveJMatch[2])
      const acc = parseNumber(moveJMatch[3])

      if (!joints || joints.length !== 6) {
        addError(index, 'MoveJ requires exactly 6 joint values.', source)
        continue
      }

      if (speed === null || acc === null || !isValidPercent(speed) || !isValidPercent(acc)) {
        addError(index, 'MoveJ speed and acc must be between 1 and 100.', source)
        continue
      }

      addStep({
        type: 'MoveJ',
        label: currentLabel || 'MoveJ',
        comment: currentComment || undefined,
        jointAngles: joints as JointAngles,
        trace: currentTraceMetadata?.trace,
        speed,
        acc
      })

      continue
    }

    const moveLMatch = normalizedLine.match(
      /^MoveL\(\s*\{([^}]*)\}\s*,\s*[^,]+,\s*[^,]+,\s*([^,]+),\s*([^,]+)(?:,.*)?\)\s*;?$/
    )

    if (moveLMatch) {
      const pose = parseNumberList(moveLMatch[1])
      const speed = parseNumber(moveLMatch[2])
      const acc = parseNumber(moveLMatch[3])

      if (!pose || pose.length !== 6) {
        addError(index, 'MoveL requires exactly 6 TCP values.', source)
        continue
      }

      if (speed === null || acc === null || !isValidPercent(speed) || !isValidPercent(acc)) {
        addError(index, 'MoveL speed and acc must be between 1 and 100.', source)
        continue
      }

      const tcpPose: TCPPose = {
        x: pose[0],
        y: pose[1],
        z: pose[2],
        rx: pose[3],
        ry: pose[4],
        rz: pose[5]
      }

      addStep({
        type: 'MoveL',
        label: currentLabel || 'MoveL',
        comment: currentComment || undefined,
        tcpPose,
        jointAngles: currentTraceMetadata?.jointAngles,
        trace: currentTraceMetadata?.trace,
        speed,
        acc
      })

      continue
    }

    const setToolDoMatch = normalizedLine.match(
      /^SetToolDO\(\s*(\d+)\s*,\s*([01])(?:\s*,.*)?\)\s*;?$/
    )

    if (setToolDoMatch) {
      const doIndex = Number(setToolDoMatch[1])
      const doValue = Number(setToolDoMatch[2]) as 0 | 1

      if (doIndex < 0 || doIndex > 1) {
        addError(index, 'Tool DO index must be between 0 and 1.', source)
        continue
      }

      addStep({
        type: 'SetDO',
        label: currentLabel || `Set tool DO ${doIndex}`,
        comment: currentComment || undefined,
        doType: 'tool',
        doIndex,
        doValue,
        speed: 50,
        acc: 50
      })

      continue
    }

    const setDoMatch = normalizedLine.match(/^SetDO\(\s*(\d+)\s*,\s*([01])(?:\s*,.*)?\)\s*;?$/)

    if (setDoMatch) {
      const doIndex = Number(setDoMatch[1])
      const doValue = Number(setDoMatch[2]) as 0 | 1

      if (doIndex < 1 || doIndex > 8) {
        addError(index, 'Cabinet DO index must be between 1 and 8.', source)
        continue
      }

      addStep({
        type: 'SetDO',
        label: currentLabel || `Set cabinet DO ${doIndex}`,
        comment: currentComment || undefined,
        doType: 'cabinet',
        doIndex,
        doValue,
        speed: 50,
        acc: 50
      })

      continue
    }

    const waitMatch = normalizedLine.match(/^WaitMs\(\s*(\d+)\s*\)\s*;?$/)

    if (waitMatch) {
      const delayMs = Number(waitMatch[1])

      addStep({
        type: 'WaitMs',
        label: currentLabel || `Wait ${delayMs} ms`,
        comment: currentComment || undefined,
        delayMs,
        speed: 50,
        acc: 50
      })

      continue
    }

    addError(index, 'Unsupported or malformed LUA statement.', source)
  }

  if (insideToDoubleHelper) {
    diagnostics.push({
      line: lines.length,
      severity: 'error',
      message: 'The toDouble helper function is missing its closing end.',
      source: lines.at(-1) || ''
    })
  }

  return {
    steps,
    projectName,
    diagnostics
  }
}
