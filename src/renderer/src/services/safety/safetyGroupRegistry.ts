function normalizeId(value: string): string {
  return value.trim()
}

function normalizeIds(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeId).filter(Boolean))].sort()
}

export class SafetyGroupRegistry {
  private readonly membersByGroupId = new Map<string, Set<string>>()
  private readonly groupIdsByRobotId = new Map<string, Set<string>>()

  setGroupMembers(groupId: string, robotIds: readonly string[]): void {
    const normalizedGroupId = normalizeId(groupId)
    if (!normalizedGroupId) {
      throw new Error('Safety group ID is required.')
    }

    this.removeGroup(normalizedGroupId)

    const members = new Set(normalizeIds(robotIds))
    if (members.size === 0) return

    this.membersByGroupId.set(normalizedGroupId, members)

    for (const robotId of members) {
      const groupIds = this.groupIdsByRobotId.get(robotId) ?? new Set<string>()
      groupIds.add(normalizedGroupId)
      this.groupIdsByRobotId.set(robotId, groupIds)
    }
  }

  removeGroup(groupId: string): void {
    const normalizedGroupId = normalizeId(groupId)
    const members = this.membersByGroupId.get(normalizedGroupId)
    if (!members) return

    this.membersByGroupId.delete(normalizedGroupId)

    for (const robotId of members) {
      const groupIds = this.groupIdsByRobotId.get(robotId)
      if (!groupIds) continue

      groupIds.delete(normalizedGroupId)
      if (groupIds.size === 0) {
        this.groupIdsByRobotId.delete(robotId)
      }
    }
  }

  getGroupIdsForRobot(robotId: string): string[] {
    const normalizedRobotId = normalizeId(robotId)
    return [...(this.groupIdsByRobotId.get(normalizedRobotId) ?? [])].sort()
  }

  getMembers(groupId: string): string[] {
    const normalizedGroupId = normalizeId(groupId)
    return [...(this.membersByGroupId.get(normalizedGroupId) ?? [])].sort()
  }

  getAllRobotIds(): string[] {
    return [...this.groupIdsByRobotId.keys()].sort()
  }

  clear(): void {
    this.membersByGroupId.clear()
    this.groupIdsByRobotId.clear()
  }
}

export const safetyGroupRegistry = new SafetyGroupRegistry()
