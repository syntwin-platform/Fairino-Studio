import type * as THREE from 'three'

import type {
  CachedObstacleBounds,
  CollisionBroadPhaseResult,
  CollisionRobotSnapshot,
  RobotCollisionPolicy
} from './collisionTypes'
import type { RobotCollisionGeometryCache } from './collisionCache'

export interface CollisionBroadPhaseOptions {
  robots: readonly CollisionRobotSnapshot[]
  obstacleBounds: readonly CachedObstacleBounds[]
  evaluateRobotIds: ReadonlySet<string>
  geometryCache: RobotCollisionGeometryCache
  getRobotPolicy: (robotId: string) => RobotCollisionPolicy
}

export function runCollisionBroadPhase(
  options: CollisionBroadPhaseOptions
): CollisionBroadPhaseResult {
  const visibleRobots = options.robots.filter((robot) => robot.visible)
  const robotById = new Map(visibleRobots.map((robot) => [robot.robotId, robot]))
  const evaluateRobotIds = new Set(
    [...options.evaluateRobotIds].filter((robotId) => robotById.has(robotId))
  )
  const groundCandidateRobotIds = new Set<string>()
  const obstacleCandidatesByRobotId = new Map<string, CachedObstacleBounds[]>()
  const robotPairCandidates: Array<[string, string]> = []

  for (const robotId of evaluateRobotIds) {
    const bounds = options.geometryCache.getBounds(robotId)
    if (!bounds) continue

    const threshold = options.getRobotPolicy(robotId).thresholds
    const groundBroadDistance = Math.max(
      threshold.groundWarningDistanceMeters,
      threshold.broadPhaseMarginMeters
    )
    const obstacleBroadDistance = Math.max(
      threshold.obstacleWarningDistanceMeters,
      threshold.broadPhaseMarginMeters
    )

    if (bounds.min.y <= groundBroadDistance) groundCandidateRobotIds.add(robotId)

    const candidates = options.obstacleBounds.filter(
      (obstacle) => boxGapDistance(bounds, obstacle.box) <= obstacleBroadDistance
    )
    if (candidates.length > 0) obstacleCandidatesByRobotId.set(robotId, candidates)
  }

  for (let leftIndex = 0; leftIndex < visibleRobots.length; leftIndex += 1) {
    const left = visibleRobots[leftIndex]
    const leftBounds = options.geometryCache.getBounds(left.robotId)
    if (!leftBounds) continue

    for (let rightIndex = leftIndex + 1; rightIndex < visibleRobots.length; rightIndex += 1) {
      const right = visibleRobots[rightIndex]
      if (!evaluateRobotIds.has(left.robotId) && !evaluateRobotIds.has(right.robotId)) continue

      const rightBounds = options.geometryCache.getBounds(right.robotId)
      if (!rightBounds) continue

      const leftThresholds = options.getRobotPolicy(left.robotId).thresholds
      const rightThresholds = options.getRobotPolicy(right.robotId).thresholds
      const broadDistance = Math.max(
        leftThresholds.robotWarningDistanceMeters,
        leftThresholds.broadPhaseMarginMeters,
        rightThresholds.robotWarningDistanceMeters,
        rightThresholds.broadPhaseMarginMeters
      )
      if (boxGapDistance(leftBounds, rightBounds) <= broadDistance) {
        robotPairCandidates.push([left.robotId, right.robotId])
        evaluateRobotIds.add(left.robotId)
        evaluateRobotIds.add(right.robotId)
      }
    }
  }

  return {
    evaluateRobotIds,
    groundCandidateRobotIds,
    obstacleCandidatesByRobotId,
    robotPairCandidates
  }
}

export function boxGapDistance(left: THREE.Box3, right: THREE.Box3): number {
  const dx = Math.max(left.min.x - right.max.x, right.min.x - left.max.x, 0)
  const dy = Math.max(left.min.y - right.max.y, right.min.y - left.max.y, 0)
  const dz = Math.max(left.min.z - right.max.z, right.min.z - left.max.z, 0)
  return Math.hypot(dx, dy, dz)
}
