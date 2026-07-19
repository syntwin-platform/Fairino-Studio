import { useSceneStore } from '../store/sceneStore'
import { useRobotStore } from '../store/robotStore'
import type {
  LatchRobotFaultInput,
  ResetRobotFaultOptions,
  RobotFaultState,
  RobotSafetyContactObservation,
  RobotSafetyContactState
} from '../types/robotFault.types'
import {
  cancelActiveCommandForRobot,
  getActiveCommandIdForRobot,
  getActiveCommandRobotIds
} from './commandExecutionRuntime'
import { executeSafetyStop } from './safety/safetyStopResolver'
import type { SafetyFaultEvent, SafetyStopCause, SafetyStopResolution } from './safety/safetyTypes'

function normalizeRobotId(robotId: string): string {
  return robotId.trim()
}

function normalizeIds(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort()
}

function arraysEqual(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index])
}

function isSameContact(
  current: RobotSafetyContactState,
  observation: RobotSafetyContactObservation,
  counterpartRobotIds: readonly string[],
  objectIds: readonly string[]
): boolean {
  return (
    current.level === observation.level &&
    current.kind === observation.kind &&
    current.message === (observation.message?.trim() || null) &&
    arraysEqual(current.counterpartRobotIds, counterpartRobotIds) &&
    arraysEqual(current.objectIds, objectIds)
  )
}

export class RobotMotionBlockedError extends Error {
  readonly robotId: string
  readonly fault: RobotFaultState

  constructor(robotId: string, fault: RobotFaultState) {
    super(`Robot ${robotId} motion blocked: ${fault.message}`)
    this.name = 'RobotMotionBlockedError'
    this.robotId = robotId
    this.fault = fault
  }
}

export function getRobotFault(robotId: string): RobotFaultState | null {
  const normalizedRobotId = normalizeRobotId(robotId)
  if (!normalizedRobotId) return null

  return useSceneStore.getState().robotFaultsById[normalizedRobotId] ?? null
}

export function getRobotSafetyContact(robotId: string): RobotSafetyContactState | null {
  const normalizedRobotId = normalizeRobotId(robotId)
  if (!normalizedRobotId) return null

  return useSceneStore.getState().robotContactsById[normalizedRobotId] ?? null
}

export function isRobotMotionBlocked(robotId: string | undefined): boolean {
  const normalizedRobotId = robotId?.trim() ?? ''
  if (!normalizedRobotId) return false

  return Boolean(useSceneStore.getState().robotFaultsById[normalizedRobotId]?.active)
}

export function throwIfRobotMotionBlocked(robotId: string | undefined): void {
  const normalizedRobotId = robotId?.trim() ?? ''
  if (!normalizedRobotId) return

  const fault = useSceneStore.getState().robotFaultsById[normalizedRobotId]
  if (fault?.active) {
    throw new RobotMotionBlockedError(normalizedRobotId, fault)
  }
}

export function latchRobotFault(robotId: string, input: LatchRobotFaultInput): RobotFaultState {
  const normalizedRobotId = normalizeRobotId(robotId)
  if (!normalizedRobotId) {
    throw new Error('Robot ID is required to latch a robot fault.')
  }

  const store = useSceneStore.getState()
  const existing = store.robotFaultsById[normalizedRobotId]

  // Preserve the first root cause until an explicit, safety-validated reset.
  if (existing?.active && existing.latched) {
    return existing
  }

  const timestamp = new Date().toISOString()
  const fault: RobotFaultState = {
    robotId: normalizedRobotId,
    active: true,
    latched: true,
    kind: input.kind,
    code: input.code.trim() || 'ROBOT_FAULT',
    message: input.message.trim() || 'Robot motion is blocked by a latched fault.',
    detectedAtUtc: timestamp,
    updatedAtUtc: timestamp
  }

  store.setRobotFault(normalizedRobotId, fault)

  if (input.cancelMotion !== false) {
    cancelActiveCommandForRobot(normalizedRobotId, fault.message)
  }

  return fault
}

function getFaultInputForSafetyStop(
  robotId: string,
  cause: SafetyStopCause,
  event: SafetyFaultEvent
): LatchRobotFaultInput {
  const eventMessage = event.message?.trim() || `Safety fault ${event.type} detected.`

  switch (cause) {
    case 'root-fault':
      return {
        kind: event.type === 'connection-lost' ? 'connection' : 'collision',
        code: event.code?.trim() || event.type.toUpperCase().replace(/-/g, '_'),
        message: eventMessage,
        cancelMotion: false
      }

    case 'safety-group':
      return {
        kind: 'safety-policy',
        code: 'SAFETY_GROUP_STOP',
        message: `Robot ${robotId} stopped by safety-group propagation. Root cause: ${eventMessage}`,
        cancelMotion: false
      }

    case 'execution-group':
      return {
        kind: 'safety-policy',
        code: 'EXECUTION_GROUP_STOP',
        message:
          `Robot ${robotId} stopped because its execution group uses ` +
          `AbortExecutionGroup. Root cause: ${eventMessage}`,
        cancelMotion: false
      }

    case 'global':
      return {
        kind: 'safety-policy',
        code: event.code?.trim() || 'GLOBAL_ESTOP',
        message: eventMessage,
        cancelMotion: false
      }
  }

  const exhaustiveCause: never = cause
  throw new Error(`Unsupported safety stop cause: ${String(exhaustiveCause)}`)
}

export function reportSafetyFaultEvent(event: SafetyFaultEvent): SafetyStopResolution {
  const configuredRobotIds = useRobotStore.getState().robots.map((robot) => robot.id)

  return executeSafetyStop(
    event,
    {
      cancelRobot: cancelActiveCommandForRobot,
      latchRobotFault: (robotId, cause, faultEvent) => {
        latchRobotFault(robotId, getFaultInputForSafetyStop(robotId, cause, faultEvent))
      }
    },
    {
      allRobotIds: [...configuredRobotIds, ...getActiveCommandRobotIds()]
    }
  )
}

export function reportRobotSafetyContact(
  robotId: string,
  observation: RobotSafetyContactObservation,
  options: { triggerSafetyAction?: boolean; forceSafetyAction?: boolean } = {}
): RobotSafetyContactState {
  const normalizedRobotId = normalizeRobotId(robotId)
  if (!normalizedRobotId) {
    throw new Error('Robot ID is required to report a safety contact.')
  }

  const counterpartRobotIds = normalizeIds(observation.counterpartRobotIds).filter(
    (id) => id !== normalizedRobotId
  )
  const objectIds = normalizeIds(observation.objectIds)
  const store = useSceneStore.getState()
  const existing = store.robotContactsById[normalizedRobotId]

  if (existing && isSameContact(existing, observation, counterpartRobotIds, objectIds)) {
    if (
      existing.level === 'collision' &&
      options.triggerSafetyAction !== false &&
      options.forceSafetyAction
    ) {
      triggerCollisionSafetyAction(existing)
    }
    return existing
  }

  const timestamp = new Date().toISOString()
  const contact: RobotSafetyContactState = {
    robotId: normalizedRobotId,
    level: observation.level,
    kind: observation.kind,
    counterpartRobotIds,
    objectIds,
    message: observation.message?.trim() || null,
    detectedAtUtc: existing?.detectedAtUtc ?? timestamp,
    updatedAtUtc: timestamp
  }

  store.setRobotContact(normalizedRobotId, contact)

  if (contact.level === 'collision' && options.triggerSafetyAction !== false) {
    triggerCollisionSafetyAction(contact)
  }

  return contact
}

function triggerCollisionSafetyAction(contact: RobotSafetyContactState): void {
  const faultType =
    contact.kind === 'robot'
      ? 'robot-robot'
      : contact.kind === 'ground'
        ? 'ground-collision'
        : contact.kind === 'self'
          ? 'self-collision'
          : 'robot-obstacle'

  reportSafetyFaultEvent({
    type: faultType,
    rootRobotIds: [contact.robotId, ...contact.counterpartRobotIds],
    objectIds: contact.objectIds,
    stopScope: 'Robot',
    code: `COLLISION_${contact.kind.toUpperCase()}`,
    message: contact.message || `Collision detected for robot ${contact.robotId}.`
  })
}

interface ClearRobotSafetyContactOptions {
  resetResolvedCollisionFault?: boolean
}

export function clearRobotSafetyContact(
  robotId: string,
  options: ClearRobotSafetyContactOptions = {}
): void {
  const normalizedRobotId = normalizeRobotId(robotId)
  if (!normalizedRobotId) return

  const store = useSceneStore.getState()
  if (options.resetResolvedCollisionFault) {
    store.resolveRobotCollision(normalizedRobotId)
    return
  }

  store.setRobotContact(normalizedRobotId, null)
}

export function resetRobotFault(robotId: string, options: ResetRobotFaultOptions): boolean {
  const normalizedRobotId = normalizeRobotId(robotId)
  if (!normalizedRobotId || !options.safetyValidated) return false

  const store = useSceneStore.getState()
  if (store.robotContactsById[normalizedRobotId]?.level === 'collision') {
    return false
  }

  store.setRobotFault(normalizedRobotId, null)
  return true
}

export interface RecoverRobotCommandFaultResult {
  recovered: boolean
  message: string
}

export interface RecoverAllRobotCommandFaultsResult {
  recoveredRobotIds: string[]
  failedByRobotId: Record<string, string>
}

function waitForCommandRegistry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/**
 * Releases a terminal command/timeout fault without weakening collision or
 * emergency-stop policy. Backend command history is intentionally preserved.
 */
export async function recoverRobotCommandFault(
  robotId: string
): Promise<RecoverRobotCommandFaultResult> {
  const normalizedRobotId = normalizeRobotId(robotId)
  if (!normalizedRobotId) {
    return { recovered: false, message: 'Robot ID is required.' }
  }

  const fault = getRobotFault(normalizedRobotId)
  if (!fault?.active || (fault.kind !== 'command' && fault.kind !== 'timeout')) {
    return {
      recovered: false,
      message: 'Chỉ có lỗi command hoặc timeout mới được khôi phục tại đây.'
    }
  }

  if (getRobotSafetyContact(normalizedRobotId)?.level === 'collision') {
    return {
      recovered: false,
      message: 'Robot vẫn đang va chạm. Hãy đưa robot về vùng an toàn trước khi khôi phục.'
    }
  }

  const activeCommandId = getActiveCommandIdForRobot(normalizedRobotId)
  if (activeCommandId) {
    cancelActiveCommandForRobot(
      normalizedRobotId,
      'Operator requested command recovery after a terminal execution error.'
    )

    const deadline = Date.now() + 2000
    while (getActiveCommandIdForRobot(normalizedRobotId) && Date.now() < deadline) {
      await waitForCommandRegistry(25)
    }

    if (getActiveCommandIdForRobot(normalizedRobotId)) {
      return {
        recovered: false,
        message: 'Command cũ vẫn đang kết thúc. Vui lòng thử lại sau vài giây.'
      }
    }
  }

  if (!resetRobotFault(normalizedRobotId, { safetyValidated: true })) {
    return {
      recovered: false,
      message: 'Không thể khôi phục vì điều kiện an toàn chưa được xác nhận.'
    }
  }

  const robotStore = useRobotStore.getState()
  robotStore.setRobotExecution(normalizedRobotId, {
    isPlaying: false,
    currentStepIndex: 0,
    lastError: undefined
  })
  robotStore.setRobotRuntime(normalizedRobotId, { lastError: undefined })

  return {
    recovered: true,
    message: 'Đã xóa trạng thái lỗi. Robot có thể nhận chương trình mới.'
  }
}

/**
 * Recovers every terminal command/timeout fault currently latched in the
 * scene. Collision, safety-policy and emergency-stop faults are excluded by
 * construction and remain latched.
 */
export async function recoverAllRobotCommandFaults(): Promise<RecoverAllRobotCommandFaultsResult> {
  const recoverableRobotIds = Object.values(useSceneStore.getState().robotFaultsById)
    .filter((fault) => fault.active && (fault.kind === 'command' || fault.kind === 'timeout'))
    .map((fault) => fault.robotId)

  const settled = await Promise.all(
    recoverableRobotIds.map(async (robotId) => ({
      robotId,
      result: await recoverRobotCommandFault(robotId)
    }))
  )

  const recoveredRobotIds: string[] = []
  const failedByRobotId: Record<string, string> = {}

  for (const { robotId, result } of settled) {
    if (result.recovered) {
      recoveredRobotIds.push(robotId)
    } else {
      failedByRobotId[robotId] = result.message
    }
  }

  return { recoveredRobotIds, failedByRobotId }
}

export function removeRobotSafetyState(robotId: string): void {
  const normalizedRobotId = normalizeRobotId(robotId)
  if (!normalizedRobotId) return

  useSceneStore.getState().clearRobotSafetyState(normalizedRobotId)
}
