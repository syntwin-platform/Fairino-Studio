import type { FactoryFailurePolicy } from '../../types/factoryProgram.types'
import type { ExecutionGroupRegistration } from './safetyTypes'

interface ExecutionGroupState {
  failurePolicy: FactoryFailurePolicy
  declaredRobotIds: Set<string>
  activeRobotIds: Set<string>
}

function normalizeId(value: string): string {
  return value.trim()
}

export class ExecutionGroupRegistry {
  private readonly groupsById = new Map<string, ExecutionGroupState>()
  private readonly groupIdsByRobotId = new Map<string, Set<string>>()

  register(registration: ExecutionGroupRegistration): void {
    const executionGroupId = normalizeId(registration.executionGroupId)
    const robotId = normalizeId(registration.robotId)
    if (!executionGroupId || !robotId) return

    const existing = this.groupsById.get(executionGroupId)
    const failurePolicy: FactoryFailurePolicy =
      existing?.failurePolicy === 'AbortExecutionGroup' ||
      registration.failurePolicy === 'AbortExecutionGroup'
        ? 'AbortExecutionGroup'
        : 'IsolateTarget'
    const group = existing ?? {
      failurePolicy,
      declaredRobotIds: new Set<string>(),
      activeRobotIds: new Set<string>()
    }

    group.failurePolicy = failurePolicy
    group.activeRobotIds.add(robotId)
    this.groupsById.set(executionGroupId, group)

    const groupIds = this.groupIdsByRobotId.get(robotId) ?? new Set<string>()
    groupIds.add(executionGroupId)
    this.groupIdsByRobotId.set(robotId, groupIds)
  }

  unregister(executionGroupId: string, robotId: string): void {
    const normalizedGroupId = normalizeId(executionGroupId)
    const normalizedRobotId = normalizeId(robotId)
    if (!normalizedGroupId || !normalizedRobotId) return

    const group = this.groupsById.get(normalizedGroupId)
    group?.activeRobotIds.delete(normalizedRobotId)
    if (group && group.activeRobotIds.size === 0 && group.declaredRobotIds.size === 0) {
      this.groupsById.delete(normalizedGroupId)
    }

    this.removeRobotIndexIfUnused(normalizedGroupId, normalizedRobotId)
  }

  setDeclaredGroupMembers(
    executionGroupId: string,
    robotIds: readonly string[],
    failurePolicy: FactoryFailurePolicy
  ): void {
    const normalizedGroupId = normalizeId(executionGroupId)
    if (!normalizedGroupId) {
      throw new Error('Execution group ID is required.')
    }

    this.clearDeclaredGroup(normalizedGroupId)

    const existing = this.groupsById.get(normalizedGroupId)
    const group = existing ?? {
      failurePolicy,
      declaredRobotIds: new Set<string>(),
      activeRobotIds: new Set<string>()
    }

    group.failurePolicy =
      group.failurePolicy === 'AbortExecutionGroup' || failurePolicy === 'AbortExecutionGroup'
        ? 'AbortExecutionGroup'
        : 'IsolateTarget'

    for (const robotId of [...new Set(robotIds.map(normalizeId).filter(Boolean))]) {
      group.declaredRobotIds.add(robotId)
      const groupIds = this.groupIdsByRobotId.get(robotId) ?? new Set<string>()
      groupIds.add(normalizedGroupId)
      this.groupIdsByRobotId.set(robotId, groupIds)
    }

    if (group.declaredRobotIds.size > 0 || group.activeRobotIds.size > 0) {
      this.groupsById.set(normalizedGroupId, group)
    }
  }

  clearDeclaredGroup(executionGroupId: string): void {
    const normalizedGroupId = normalizeId(executionGroupId)
    const group = this.groupsById.get(normalizedGroupId)
    if (!group) return

    const declaredRobotIds = [...group.declaredRobotIds]
    group.declaredRobotIds.clear()

    for (const robotId of declaredRobotIds) {
      this.removeRobotIndexIfUnused(normalizedGroupId, robotId)
    }

    if (group.activeRobotIds.size === 0) {
      this.groupsById.delete(normalizedGroupId)
    }
  }

  getGroupIdsForRobot(robotId: string): string[] {
    const normalizedRobotId = normalizeId(robotId)
    return [...(this.groupIdsByRobotId.get(normalizedRobotId) ?? [])].sort()
  }

  getMembers(executionGroupId: string): string[] {
    const normalizedGroupId = normalizeId(executionGroupId)
    const group = this.groupsById.get(normalizedGroupId)
    if (!group) return []

    return [...new Set([...group.declaredRobotIds, ...group.activeRobotIds])].sort()
  }

  getFailurePolicy(executionGroupId: string): FactoryFailurePolicy | null {
    const normalizedGroupId = normalizeId(executionGroupId)
    return this.groupsById.get(normalizedGroupId)?.failurePolicy ?? null
  }

  getAllRobotIds(): string[] {
    return [...this.groupIdsByRobotId.keys()].sort()
  }

  clear(): void {
    this.groupsById.clear()
    this.groupIdsByRobotId.clear()
  }

  private removeRobotIndexIfUnused(executionGroupId: string, robotId: string): void {
    const group = this.groupsById.get(executionGroupId)
    if (group?.declaredRobotIds.has(robotId) || group?.activeRobotIds.has(robotId)) return

    const groupIds = this.groupIdsByRobotId.get(robotId)
    groupIds?.delete(executionGroupId)
    if (groupIds?.size === 0) {
      this.groupIdsByRobotId.delete(robotId)
    }
  }
}

export const executionGroupRegistry = new ExecutionGroupRegistry()
