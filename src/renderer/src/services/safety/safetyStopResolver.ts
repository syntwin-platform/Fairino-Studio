import { ExecutionGroupRegistry, executionGroupRegistry } from './executionGroupRegistry'
import { SafetyGroupRegistry, safetyGroupRegistry } from './safetyGroupRegistry'
import type {
  SafetyFaultEvent,
  SafetyStopCause,
  SafetyStopEffects,
  SafetyStopResolution,
  SafetyStopResolverOptions
} from './safetyTypes'

const CAUSE_PRIORITY: Record<SafetyStopCause, number> = {
  'safety-group': 1,
  'execution-group': 2,
  'root-fault': 3,
  global: 4
}

function normalizeIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
}

function setCause(
  causeByRobotId: Record<string, SafetyStopCause>,
  robotId: string,
  cause: SafetyStopCause
): boolean {
  const existing = causeByRobotId[robotId]
  if (existing && CAUSE_PRIORITY[existing] >= CAUSE_PRIORITY[cause]) return false

  causeByRobotId[robotId] = cause
  return !existing
}

function getEventScope(event: SafetyFaultEvent): 'Robot' | 'SafetyGroup' | 'All' {
  if (event.type === 'global-estop') return 'All'
  return event.stopScope ?? 'SafetyGroup'
}

export function resolveSafetyStop(
  event: SafetyFaultEvent,
  options: SafetyStopResolverOptions = {},
  safetyGroups: SafetyGroupRegistry = safetyGroupRegistry,
  executionGroups: ExecutionGroupRegistry = executionGroupRegistry
): SafetyStopResolution {
  const rootRobotIds = normalizeIds(event.rootRobotIds)
  const scope = getEventScope(event)
  const causeByRobotId: Record<string, SafetyStopCause> = {}
  const affectedSafetyGroupIds = new Set<string>()
  const affectedExecutionGroupIds = new Set<string>()

  if (scope === 'All') {
    const allRobotIds = normalizeIds([
      ...rootRobotIds,
      ...(options.allRobotIds ?? []),
      ...safetyGroups.getAllRobotIds(),
      ...executionGroups.getAllRobotIds()
    ])

    for (const robotId of allRobotIds) {
      causeByRobotId[robotId] = 'global'
      for (const groupId of safetyGroups.getGroupIdsForRobot(robotId)) {
        affectedSafetyGroupIds.add(groupId)
      }
      for (const groupId of executionGroups.getGroupIdsForRobot(robotId)) {
        affectedExecutionGroupIds.add(groupId)
      }
    }

    return {
      event,
      rootRobotIds,
      safetyGroupRobotIds: [],
      executionGroupRobotIds: [],
      stopRobotIds: allRobotIds,
      affectedSafetyGroupIds: [...affectedSafetyGroupIds].sort(),
      affectedExecutionGroupIds: [...affectedExecutionGroupIds].sort(),
      causeByRobotId
    }
  }

  for (const robotId of rootRobotIds) {
    setCause(causeByRobotId, robotId, 'root-fault')
  }

  let changed = true

  while (changed) {
    changed = false
    const currentRobotIds = Object.keys(causeByRobotId)

    if (scope === 'SafetyGroup') {
      for (const robotId of currentRobotIds) {
        for (const groupId of safetyGroups.getGroupIdsForRobot(robotId)) {
          affectedSafetyGroupIds.add(groupId)

          for (const memberRobotId of safetyGroups.getMembers(groupId)) {
            changed = setCause(causeByRobotId, memberRobotId, 'safety-group') || changed
          }
        }
      }
    }

    if (scope !== 'Robot') {
      for (const robotId of Object.keys(causeByRobotId)) {
        for (const groupId of executionGroups.getGroupIdsForRobot(robotId)) {
          if (executionGroups.getFailurePolicy(groupId) !== 'AbortExecutionGroup') continue

          affectedExecutionGroupIds.add(groupId)

          for (const memberRobotId of executionGroups.getMembers(groupId)) {
            changed = setCause(causeByRobotId, memberRobotId, 'execution-group') || changed
          }
        }
      }
    }
  }

  const stopRobotIds = Object.keys(causeByRobotId).sort()

  return {
    event,
    rootRobotIds,
    safetyGroupRobotIds: stopRobotIds.filter(
      (robotId) => causeByRobotId[robotId] === 'safety-group'
    ),
    executionGroupRobotIds: stopRobotIds.filter(
      (robotId) => causeByRobotId[robotId] === 'execution-group'
    ),
    stopRobotIds,
    affectedSafetyGroupIds: [...affectedSafetyGroupIds].sort(),
    affectedExecutionGroupIds: [...affectedExecutionGroupIds].sort(),
    causeByRobotId
  }
}

export function getSafetyStopReason(event: SafetyFaultEvent): string {
  const fallback =
    event.type === 'global-estop'
      ? 'Global emergency stop requested.'
      : `Safety fault ${event.type} requires motion to stop.`

  return event.message?.trim() || fallback
}

export function executeSafetyStop(
  event: SafetyFaultEvent,
  effects: SafetyStopEffects,
  options: SafetyStopResolverOptions = {},
  safetyGroups: SafetyGroupRegistry = safetyGroupRegistry,
  executionGroups: ExecutionGroupRegistry = executionGroupRegistry
): SafetyStopResolution {
  const resolution = resolveSafetyStop(event, options, safetyGroups, executionGroups)
  const reason = getSafetyStopReason(event)

  // Stop every resolved command first. Fault visualization is applied in a
  // second pass so a rendering/store failure cannot delay another robot stop.
  for (const robotId of resolution.stopRobotIds) {
    try {
      effects.cancelRobot(robotId, reason)
    } catch (error) {
      console.error('[SafetyStopResolver] Failed to cancel robot command', {
        robotId,
        error
      })
    }
  }

  for (const robotId of resolution.stopRobotIds) {
    try {
      effects.latchRobotFault(robotId, resolution.causeByRobotId[robotId], event)
    } catch (error) {
      console.error('[SafetyStopResolver] Failed to latch robot fault', {
        robotId,
        error
      })
    }
  }

  return resolution
}
