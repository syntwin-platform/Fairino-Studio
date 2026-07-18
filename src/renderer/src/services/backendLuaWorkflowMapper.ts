import type { WorkflowStep } from '../types/robot.types'
import type { BackendLuaPreviewStep } from './backendLuaImportClient'

function percent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(1, value))
    : 50
}

export function toWorkflowStep(step: BackendLuaPreviewStep): WorkflowStep | null {
  const payload = step.payload || {}
  const id = `step_imported_${step.orderIndex}`

  switch (step.stepType) {
    case 'MoveJ':
      if (!Array.isArray(payload.jointAngles) || payload.jointAngles.length !== 6) return null
      return {
        id,
        type: 'MoveJ',
        label: step.label,
        jointAngles: payload.jointAngles as WorkflowStep['jointAngles'],
        speed: percent(payload.speed),
        acc: percent(payload.acc)
      }

    case 'MoveL':
      if (
        typeof payload.tcpPose !== 'object' ||
        payload.tcpPose === null ||
        Array.isArray(payload.tcpPose)
      )
        return null
      return {
        id,
        type: 'MoveL',
        label: step.label,
        tcpPose: payload.tcpPose as WorkflowStep['tcpPose'],
        speed: percent(payload.speed),
        acc: percent(payload.acc)
      }

    case 'SetDO':
      return {
        id,
        type: 'SetDO',
        label: step.label,
        doType: payload.doType === 'tool' ? 'tool' : 'cabinet',
        doIndex: typeof payload.doIndex === 'number' ? payload.doIndex : 1,
        doValue: payload.doValue === 1 ? 1 : 0,
        speed: 50,
        acc: 50
      }

    case 'WaitMs':
      return {
        id,
        type: 'WaitMs',
        label: step.label,
        delayMs: typeof payload.delayMs === 'number' ? payload.delayMs : 0,
        speed: 50,
        acc: 50
      }

    case 'GripperOpen':
    case 'GripperClose':
      return { id, type: step.stepType, label: step.label, speed: 50, acc: 50 }

    default:
      return null
  }
}
