import { runCollisionBroadPhase } from './collisionBroadPhase'
import { ObstacleBoundsCache, RobotCollisionGeometryCache } from './collisionCache'
import { runCollisionNarrowPhase } from './collisionNarrowPhase'
import type {
  CollisionContactTransition,
  CollisionEngineOptions,
  CollisionEngineTickResult,
  CollisionMonitoringMode,
  CollisionObservation,
  CollisionRobotSnapshot
} from './collisionTypes'

interface RobotContactState {
  emitted: CollisionObservation | null
  pendingTicksByKey: Map<string, number>
  clearTicks: number
  monitoringMode: CollisionMonitoringMode
}

interface CollisionEngineDisposeOptions {
  emitClearTransitions?: boolean
}

export class CollisionEngine {
  private readonly obstacleCache = new ObstacleBoundsCache()
  private readonly geometryCache = new RobotCollisionGeometryCache()
  private readonly contactStates = new Map<string, RobotContactState>()
  private readonly settleTicksByRobotId = new Map<string, number>()
  private readonly now: () => number
  private exactCheckOffset = 0
  private forceFullEvaluation = true
  private disposed = false

  constructor(private readonly options: CollisionEngineOptions) {
    this.now = options.now ?? (() => performance.now())
  }

  tick(): CollisionEngineTickResult {
    const startedAt = this.now()
    if (this.disposed) return emptyTickResult(this.now() - startedAt)

    const snapshot = this.options.getSnapshot()
    const monitoredRobots = snapshot.robots.filter((robot) => robot.visible)
    const robotsById = new Map(monitoredRobots.map((robot) => [robot.robotId, robot]))
    const transitions: CollisionContactTransition[] = []

    const obstacleSync = this.obstacleCache.sync(snapshot.obstacles)
    const evaluateRobotIds = new Set<string>()
    for (const robot of monitoredRobots) {
      robot.object.updateWorldMatrix(true, true)
      const boundsUpdate = this.geometryCache.updateBoundsWithStatus(robot)
      const contactState = this.contactStates.get(robot.robotId)
      const monitoringModeChanged =
        Boolean(contactState) && contactState?.monitoringMode !== robot.monitoringMode
      if (boundsUpdate.changed || obstacleSync.changed || this.forceFullEvaluation) {
        // Keep a short follow-up window for confirmation ticks and work-budget spillover. Static
        // robots leave the hot path after the window instead of being rescanned forever.
        this.settleTicksByRobotId.set(robot.robotId, 8)
      }

      const settleTicks = this.settleTicksByRobotId.get(robot.robotId) ?? 0
      if (
        settleTicks > 0 ||
        monitoringModeChanged ||
        Boolean(contactState?.emitted) ||
        Boolean(contactState && contactState.pendingTicksByKey.size > 0)
      ) {
        evaluateRobotIds.add(robot.robotId)
      }
    }
    this.forceFullEvaluation = false
    const primaryEvaluateRobotIds = new Set(evaluateRobotIds)

    if (evaluateRobotIds.size === 0) {
      return {
        ...emptyTickResult(this.now() - startedAt),
        narrowPhaseRobotCount: monitoredRobots.length
      }
    }

    const broadPhase = runCollisionBroadPhase({
      robots: monitoredRobots,
      obstacleBounds: obstacleSync.bounds,
      evaluateRobotIds,
      geometryCache: this.geometryCache,
      getRobotPolicy: this.options.getRobotPolicy
    })

    const linkSnapshotsByRobotId = new Map()
    for (const robotId of broadPhase.evaluateRobotIds) {
      const robot = robotsById.get(robotId)
      if (robot) {
        const linkSnapshot = this.geometryCache.buildLinkObbSnapshot(robot)
        if (linkSnapshot.linkObbs.size > 0) linkSnapshotsByRobotId.set(robotId, linkSnapshot)
      }
    }

    const exactWorkBudgetByRobotId = new Map(
      monitoredRobots.map((robot) => [
        robot.robotId,
        {
          remainingMeasurements: Math.max(
            1,
            this.options.getRobotPolicy(robot.robotId).thresholds.maxExactMeasurementsPerTick ?? 2
          )
        }
      ])
    )
    const totalRobotBudget = [...exactWorkBudgetByRobotId.values()].reduce(
      (total, budget) => total + budget.remainingMeasurements,
      0
    )
    const observations = runCollisionNarrowPhase({
      robotsById,
      primaryEvaluateRobotIds,
      linkSnapshotsByRobotId,
      groundCandidateRobotIds: broadPhase.groundCandidateRobotIds,
      obstacleCandidatesByRobotId: broadPhase.obstacleCandidatesByRobotId,
      robotPairCandidates: broadPhase.robotPairCandidates,
      geometryCache: this.geometryCache,
      robotPairExactWorkBudget: {
        remainingMeasurements: Math.max(2, Math.min(8, totalRobotBudget))
      },
      exactWorkBudgetByRobotId,
      exactCheckOffset: this.exactCheckOffset,
      getRobotPolicy: this.options.getRobotPolicy
    })
    this.exactCheckOffset += 1

    for (const robotId of broadPhase.evaluateRobotIds) {
      const robot = robotsById.get(robotId)
      if (!robot) continue
      const transition = this.advanceContactState(robot, observations.get(robotId) ?? [])
      if (transition) transitions.push(transition)
    }

    for (const robotId of primaryEvaluateRobotIds) {
      const remainingTicks = (this.settleTicksByRobotId.get(robotId) ?? 0) - 1
      if (remainingTicks > 0) this.settleTicksByRobotId.set(robotId, remainingTicks)
      else this.settleTicksByRobotId.delete(robotId)
    }

    this.emitTransitions(transitions)
    return {
      evaluatedRobotCount: evaluateRobotIds.size,
      narrowPhaseRobotCount: linkSnapshotsByRobotId.size,
      obstacleCandidateCount: [...broadPhase.obstacleCandidatesByRobotId.values()].reduce(
        (total, candidates) => total + candidates.length,
        0
      ),
      robotPairCandidateCount: broadPhase.robotPairCandidates.length,
      transitionCount: transitions.length,
      durationMs: this.now() - startedAt
    }
  }

  removeRobot(robotId: string): void {
    this.geometryCache.remove(robotId)
    this.settleTicksByRobotId.delete(robotId)
    const state = this.contactStates.get(robotId)
    this.contactStates.delete(robotId)
    if (state?.emitted) {
      this.options.onContactTransition({
        robotId,
        monitoringMode: state.monitoringMode,
        observation: null
      })
    }
  }

  getActiveContacts(): Array<{
    robotId: string
    monitoringMode: CollisionMonitoringMode
    observation: CollisionObservation
  }> {
    const contacts: Array<{
      robotId: string
      monitoringMode: CollisionMonitoringMode
      observation: CollisionObservation
    }> = []
    for (const [robotId, state] of this.contactStates) {
      if (!state.emitted) continue
      contacts.push({
        robotId,
        monitoringMode: state.monitoringMode,
        observation: state.emitted
      })
    }
    return contacts
  }

  prewarmExactGeometry(maxNewTrees = 1): boolean {
    if (this.disposed) return true
    const snapshot = this.options.getSnapshot()
    const robots = snapshot.robots.filter((robot) => robot.visible)
    let remainingTreeBudget = Math.max(1, maxNewTrees)

    for (const robot of robots) {
      if (remainingTreeBudget <= 0) return false
      robot.object.updateWorldMatrix(true, true)
      const result = this.geometryCache.prewarmExactGeometry(robot, remainingTreeBudget)
      remainingTreeBudget -= result.preparedTreeCount
      if (!result.complete) return false
    }

    for (const obstacle of snapshot.obstacles.filter((item) => item.visible)) {
      if (remainingTreeBudget <= 0) return false
      obstacle.object.updateWorldMatrix(true, true)
      const result = this.geometryCache.prewarmObjectExactGeometry(
        obstacle.object,
        remainingTreeBudget
      )
      remainingTreeBudget -= result.preparedTreeCount
      if (!result.complete) return false
    }

    this.forceFullEvaluation = true
    return true
  }

  isExactGeometryReady(): boolean {
    if (this.disposed) return false
    const snapshot = this.options.getSnapshot()
    const robots = snapshot.robots.filter((robot) => robot.visible)
    if (robots.length === 0) return false
    if (!robots.every((robot) => this.geometryCache.isExactGeometryReady(robot))) return false

    return snapshot.obstacles
      .filter((obstacle) => obstacle.visible)
      .every((obstacle) => this.geometryCache.isObjectExactGeometryReady(obstacle.object))
  }

  dispose(options: CollisionEngineDisposeOptions = {}): void {
    this.disposed = true
    if (options.emitClearTransitions ?? true) {
      for (const [robotId, state] of this.contactStates) {
        if (state.emitted) {
          this.options.onContactTransition({
            robotId,
            monitoringMode: state.monitoringMode,
            observation: null
          })
        }
      }
    }
    this.obstacleCache.clear()
    this.geometryCache.clear()
    this.contactStates.clear()
    this.settleTicksByRobotId.clear()
  }

  private advanceContactState(
    robot: CollisionRobotSnapshot,
    observations: readonly CollisionObservation[]
  ): CollisionContactTransition | null {
    const state = this.contactStates.get(robot.robotId) ?? createContactState(robot.monitoringMode)
    this.contactStates.set(robot.robotId, state)
    const monitoringModeChanged = state.monitoringMode !== robot.monitoringMode
    state.monitoringMode = robot.monitoringMode
    const policy = this.options.getRobotPolicy(robot.robotId).thresholds
    const collisionObservations = observations.filter(
      (observation) => observation.level === 'collision'
    )
    const observedCollisionKeys = new Set(
      collisionObservations.map((observation) => observation.confirmationKey)
    )

    for (const confirmationKey of state.pendingTicksByKey.keys()) {
      if (!observedCollisionKeys.has(confirmationKey)) {
        state.pendingTicksByKey.delete(confirmationKey)
      }
    }
    for (const observation of collisionObservations) {
      state.pendingTicksByKey.set(
        observation.confirmationKey,
        (state.pendingTicksByKey.get(observation.confirmationKey) ?? 0) + 1
      )
    }

    const confirmedCollisions = collisionObservations.filter(
      (observation) =>
        (state.pendingTicksByKey.get(observation.confirmationKey) ?? 0) >=
        requiredConfirmTicksForObservation(observation, policy.confirmTicks)
    )
    const pendingCollisionWarnings = collisionObservations
      .filter(
        (observation) =>
          (state.pendingTicksByKey.get(observation.confirmationKey) ?? 0) <
          requiredConfirmTicksForObservation(observation, policy.confirmTicks)
      )
      .map(toPendingCollisionWarning)
    const proximityObservations = observations.filter(
      (observation) => observation.level === 'proximity'
    )

    const desiredObservation =
      chooseStableObservation(confirmedCollisions, state.emitted) ??
      chooseStableObservation(
        [...proximityObservations, ...pendingCollisionWarnings],
        state.emitted
      )

    if (state.emitted?.level === 'collision' && desiredObservation?.level !== 'collision') {
      state.clearTicks += 1
      if (state.clearTicks < Math.max(1, policy.clearTicks)) return null
    } else if (!desiredObservation && state.emitted) {
      state.clearTicks += 1
      if (state.clearTicks < Math.max(1, policy.clearTicks)) return null
    } else {
      state.clearTicks = 0
    }

    if (!desiredObservation) {
      state.clearTicks = 0
      if (!state.emitted) return null
      state.emitted = null
      return {
        robotId: robot.robotId,
        monitoringMode: robot.monitoringMode,
        observation: null
      }
    }

    state.clearTicks = 0
    if (!monitoringModeChanged && sameContactIdentity(state.emitted, desiredObservation))
      return null
    state.emitted = desiredObservation
    return {
      robotId: robot.robotId,
      monitoringMode: robot.monitoringMode,
      observation: desiredObservation
    }
  }

  private emitTransitions(transitions: readonly CollisionContactTransition[]): void {
    for (const transition of transitions) this.options.onContactTransition(transition)
  }
}

function createContactState(monitoringMode: CollisionMonitoringMode): RobotContactState {
  return {
    emitted: null,
    pendingTicksByKey: new Map(),
    clearTicks: 0,
    monitoringMode
  }
}

function sameContactIdentity(
  left: CollisionObservation | null,
  right: CollisionObservation
): boolean {
  return (
    left?.level === right.level &&
    left.confirmationKey === right.confirmationKey &&
    left.source === right.source
  )
}

function toPendingCollisionWarning(observation: CollisionObservation): CollisionObservation {
  return {
    ...observation,
    level: 'proximity',
    message: `Possible ${observation.kind} collision is being confirmed. ${observation.message}`
  }
}

function requiredConfirmTicksForObservation(
  observation: CollisionObservation,
  configuredConfirmTicks: number
): number {
  // Ground penetration is calculated directly from the link's mesh vertices. It is deterministic
  // and does not need the temporal confirmation used by BVH pair contacts.
  if (observation.kind === 'ground') return 1
  return Math.max(1, configuredConfirmTicks)
}

function chooseStableObservation(
  observations: readonly CollisionObservation[],
  emitted: CollisionObservation | null
): CollisionObservation | null {
  if (observations.length === 0) return null

  const current = emitted
    ? observations.find((observation) => observation.confirmationKey === emitted.confirmationKey)
    : null
  if (current) return current

  return [...observations].sort(compareObservationPriority)[0]
}

function compareObservationPriority(
  left: CollisionObservation,
  right: CollisionObservation
): number {
  const kindPriority: Record<CollisionObservation['kind'], number> = {
    ground: 4,
    robot: 3,
    self: 2,
    obstacle: 1
  }
  return (
    kindPriority[right.kind] - kindPriority[left.kind] ||
    left.distanceMeters - right.distanceMeters ||
    left.confirmationKey.localeCompare(right.confirmationKey)
  )
}

function emptyTickResult(durationMs: number): CollisionEngineTickResult {
  return {
    evaluatedRobotCount: 0,
    narrowPhaseRobotCount: 0,
    obstacleCandidateCount: 0,
    robotPairCandidateCount: 0,
    transitionCount: 0,
    durationMs
  }
}
