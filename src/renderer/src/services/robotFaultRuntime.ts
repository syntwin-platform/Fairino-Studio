import { useSceneStore } from '../store/sceneStore'
import type {
  LatchRobotFaultInput,
  ResetRobotFaultOptions,
  RobotFaultState,
  RobotSafetyContactObservation,
  RobotSafetyContactState
} from '../types/robotFault.types'
import { cancelActiveCommandForRobot } from './commandExecutionRuntime'

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

export function reportRobotSafetyContact(
  robotId: string,
  observation: RobotSafetyContactObservation
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

  if (contact.level === 'collision') {
    latchRobotFault(normalizedRobotId, {
      kind: 'collision',
      code: `COLLISION_${contact.kind.toUpperCase()}`,
      message: contact.message || `Collision detected for robot ${normalizedRobotId}.`
    })
  }

  return contact
}

export function clearRobotSafetyContact(robotId: string): void {
  const normalizedRobotId = normalizeRobotId(robotId)
  if (!normalizedRobotId) return

  useSceneStore.getState().setRobotContact(normalizedRobotId, null)
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

export function removeRobotSafetyState(robotId: string): void {
  const normalizedRobotId = normalizeRobotId(robotId)
  if (!normalizedRobotId) return

  useSceneStore.getState().clearRobotSafetyState(normalizedRobotId)
}
