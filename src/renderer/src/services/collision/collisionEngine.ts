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
  private readonly now: () => number
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
    // Every visible robot participates in monitoring, including an offline/static Factory robot.
    // Monitoring only publishes observations; the Viewport callback still limits stop actions to
    // factory-active robots, so this does not turn an offline preview into an execution command.
    const primaryEvaluateRobotIds = new Set(monitoredRobots.map((robot) => robot.robotId))
    const transitions: CollisionContactTransition[] = []

    const obstacleSync = this.obstacleCache.sync(snapshot.obstacles)
    const evaluateRobotIds = new Set<string>()
    for (const robot of monitoredRobots) {
      // Monitoring is continuous in both Training and Factory. Immutable geometry is cached;
      // only world transforms and broad-phase bounds are refreshed on each scheduler tick.
      robot.object.updateWorldMatrix(true, true)
      this.geometryCache.updateBounds(robot)
      evaluateRobotIds.add(robot.robotId)
    }

    if (evaluateRobotIds.size === 0) {
      for (const robot of monitoredRobots) {
        const transition = this.advanceContactState(robot, [])
        if (transition) transitions.push(transition)
      }
      this.emitTransitions(transitions)
      return {
        ...emptyTickResult(this.now() - startedAt),
        transitionCount: transitions.length
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
      if (robot) linkSnapshotsByRobotId.set(robotId, this.geometryCache.buildLinkObbSnapshot(robot))
    }

    const observations = runCollisionNarrowPhase({
      robotsById,
      primaryEvaluateRobotIds,
      linkSnapshotsByRobotId,
      groundCandidateRobotIds: broadPhase.groundCandidateRobotIds,
      obstacleCandidatesByRobotId: broadPhase.obstacleCandidatesByRobotId,
      robotPairCandidates: broadPhase.robotPairCandidates,
      geometryCache: this.geometryCache,
      getRobotPolicy: this.options.getRobotPolicy
    })

    for (const robot of monitoredRobots) {
      const robotId = robot.robotId
      const transition = this.advanceContactState(robot, observations.get(robotId) ?? [])
      if (transition) transitions.push(transition)
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

    const requiredConfirmTicks = Math.max(1, policy.confirmTicks)
    const confirmedCollisions = collisionObservations.filter(
      (observation) =>
        (state.pendingTicksByKey.get(observation.confirmationKey) ?? 0) >= requiredConfirmTicks
    )
    const pendingCollisionWarnings = collisionObservations
      .filter(
        (observation) =>
          (state.pendingTicksByKey.get(observation.confirmationKey) ?? 0) < requiredConfirmTicks
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
  return left?.level === right.level && left.confirmationKey === right.confirmationKey
}

function toPendingCollisionWarning(observation: CollisionObservation): CollisionObservation {
  return {
    ...observation,
    level: 'proximity',
    message: `Possible ${observation.kind} collision is being confirmed. ${observation.message}`
  }
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
    robot: 4,
    obstacle: 3,
    self: 2,
    ground: 1
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
