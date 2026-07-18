import * as THREE from 'three'
import type { OBB } from 'three/examples/jsm/math/OBB.js'

import type { ExactCollisionWorkBudget, RobotCollisionGeometryCache } from './collisionCache'
import type {
  CachedObstacleBounds,
  CollisionObservation,
  CollisionRobotSnapshot,
  RobotCollisionPolicy,
  RobotLinkObbSnapshot
} from './collisionTypes'

export interface CollisionNarrowPhaseOptions {
  robotsById: ReadonlyMap<string, CollisionRobotSnapshot>
  primaryEvaluateRobotIds: ReadonlySet<string>
  linkSnapshotsByRobotId: ReadonlyMap<string, RobotLinkObbSnapshot>
  groundCandidateRobotIds: ReadonlySet<string>
  obstacleCandidatesByRobotId: ReadonlyMap<string, readonly CachedObstacleBounds[]>
  robotPairCandidates: ReadonlyArray<readonly [string, string]>
  geometryCache: RobotCollisionGeometryCache
  robotPairExactWorkBudget: ExactCollisionWorkBudget
  exactWorkBudgetByRobotId: ReadonlyMap<string, ExactCollisionWorkBudget>
  exactCheckOffset: number
  getRobotPolicy: (robotId: string) => RobotCollisionPolicy
}

export function runCollisionNarrowPhase(
  options: CollisionNarrowPhaseOptions
): Map<string, CollisionObservation[]> {
  const observations = new Map<string, CollisionObservation[]>()

  // Robot-to-robot candidates have the highest safety priority. Resolve them before self and
  // obstacle jobs so the per-tick exact budget cannot be exhausted by lower-priority checks.
  for (const [leftRobotId, rightRobotId] of options.robotPairCandidates) {
    const left = options.linkSnapshotsByRobotId.get(leftRobotId)
    const right = options.linkSnapshotsByRobotId.get(rightRobotId)
    if (!left || !right) continue

    const pair = detectRobotPairContact(
      left,
      right,
      options.robotsById.get(leftRobotId),
      options.robotsById.get(rightRobotId),
      options.getRobotPolicy(leftRobotId),
      options.getRobotPolicy(rightRobotId),
      options.geometryCache,
      options.robotPairExactWorkBudget
    )
    appendObservation(observations, pair.left)
    appendObservation(observations, pair.right)
  }

  for (const [robotId, linkSnapshot] of options.linkSnapshotsByRobotId) {
    const robot = options.robotsById.get(robotId)
    if (!robot) continue
    const policy = options.getRobotPolicy(robotId)
    const exactWorkBudget = options.exactWorkBudgetByRobotId.get(robotId)

    if (
      options.primaryEvaluateRobotIds.has(robotId) &&
      options.groundCandidateRobotIds.has(robotId)
    ) {
      appendObservation(
        observations,
        detectGroundContact(robot, linkSnapshot, policy, options.geometryCache)
      )
    }
    if (options.primaryEvaluateRobotIds.has(robotId) && exactWorkBudget) {
      for (const selfContact of detectSelfContacts(
        robot,
        linkSnapshot,
        policy,
        options.geometryCache,
        exactWorkBudget,
        options.exactCheckOffset
      )) {
        appendObservation(observations, selfContact)
      }

      for (const obstacle of options.obstacleCandidatesByRobotId.get(robotId) ?? []) {
        appendObservation(
          observations,
          detectObstacleContact(
            robot,
            linkSnapshot,
            obstacle,
            policy,
            options.geometryCache,
            exactWorkBudget
          )
        )
      }
    }
  }

  return observations
}

function detectGroundContact(
  robot: CollisionRobotSnapshot,
  snapshot: RobotLinkObbSnapshot,
  policy: RobotCollisionPolicy,
  geometryCache: RobotCollisionGeometryCache
): CollisionObservation | null {
  let best: CollisionObservation | null = null

  for (const [linkName, obb] of snapshot.linkObbs) {
    if (matchesAnyPattern(linkName, policy.geometry.groundIgnoredLinkPatterns)) continue

    const approximateMinimumY = obbToBox3(obb).min.y
    if (approximateMinimumY > policy.thresholds.groundWarningDistanceMeters) continue
    const exactMinimumY = geometryCache.getExactMinimumWorldY(robot, linkName)
    // A partially attached runtime mesh can expose a valid link bound before its position
    // attribute is available for the vertex-level query. Never use that conservative bound for
    // a near-ground warning, but do fail safe when it is already clearly below the floor.
    const fallbackPenetrationThreshold = Math.max(
      0.02,
      policy.thresholds.groundPenetrationToleranceMeters * 5
    )
    if (exactMinimumY === null && approximateMinimumY >= -fallbackPenetrationThreshold) continue
    const minimumY = exactMinimumY ?? approximateMinimumY

    const penetration = -minimumY
    const isCollision = penetration > policy.thresholds.groundPenetrationToleranceMeters
    const distanceMeters = Math.max(0, minimumY)
    if (!isCollision && distanceMeters > policy.thresholds.groundWarningDistanceMeters) continue

    best = preferObservation(best, {
      robotId: robot.robotId,
      level: isCollision ? 'collision' : 'proximity',
      kind: 'ground',
      confirmationKey: `ground:${robot.robotId}`,
      signature: `ground:${linkName}`,
      counterpartRobotIds: [],
      objectIds: [],
      distanceMeters,
      message: isCollision
        ? `Robot link ${linkName} intersects the ground safety plane by ${(penetration * 1000).toFixed(1)} mm.`
        : `Robot link ${linkName} is ${(distanceMeters * 1000).toFixed(1)} mm above the ground safety plane.`,
      source: exactMinimumY === null ? 'ground-bounds-fallback' : 'ground-distance'
    })
  }
  return best
}

function detectSelfContacts(
  robot: CollisionRobotSnapshot,
  snapshot: RobotLinkObbSnapshot,
  policy: RobotCollisionPolicy,
  geometryCache: RobotCollisionGeometryCache,
  exactWorkBudget: ExactCollisionWorkBudget,
  exactCheckOffset: number
): CollisionObservation[] {
  const contacts: CollisionObservation[] = []
  const selfCollisionPairs = rotateItems(policy.geometry.selfCollisionPairs, exactCheckOffset)
  for (const pair of selfCollisionPairs) {
    const left = findLinkObb(snapshot.linkObbs, pair.a)
    const right = findLinkObb(snapshot.linkObbs, pair.b)
    if (!left || !right) continue

    const approximateDistance = obbGapDistance(left, right)
    const warningDistance = policy.thresholds.selfWarningDistanceMeters
    if (approximateDistance > warningDistance) continue

    const probe = geometryCache.probeLinkPairExact(
      robot,
      pair.a,
      robot,
      pair.b,
      warningDistance,
      exactWorkBudget
    )
    if (probe === null) continue
    if (probe.status === 'pending') continue
    const measurement = probe.measurement
    const level = classifyExactDistance(
      measurement.distanceMeters,
      measurement.intersects,
      warningDistance
    )
    if (!level) continue

    contacts.push({
      robotId: snapshot.robotId,
      level,
      kind: 'self',
      confirmationKey: `self:${snapshot.robotId}:${pair.a}:${pair.b}`,
      signature: `self:${pair.a}:${pair.b}`,
      counterpartRobotIds: [],
      objectIds: [],
      distanceMeters: measurement.distanceMeters,
      message:
        level === 'collision'
          ? `Robot links ${pair.a} and ${pair.b} intersect.`
          : `Robot links ${pair.a} and ${pair.b} are too close.`,
      source: measurement.intersects ? 'exact-intersection' : 'exact-distance'
    })
  }
  return contacts
}

function detectObstacleContact(
  robot: CollisionRobotSnapshot,
  snapshot: RobotLinkObbSnapshot,
  obstacle: CachedObstacleBounds,
  policy: RobotCollisionPolicy,
  geometryCache: RobotCollisionGeometryCache,
  exactWorkBudget: ExactCollisionWorkBudget
): CollisionObservation | null {
  let best: CollisionObservation | null = null
  for (const [linkName, linkObb] of snapshot.linkObbs) {
    const approximateDistance = obbBoxGapDistance(linkObb, obstacle.box)
    const warningDistance = policy.thresholds.obstacleWarningDistanceMeters
    if (approximateDistance > warningDistance) continue

    const probe = geometryCache.probeLinkObjectExact(
      robot,
      linkName,
      obstacle.object,
      warningDistance,
      exactWorkBudget
    )
    if (probe === null) continue
    if (probe.status === 'pending') continue
    const measurement = probe.measurement
    const level = classifyExactDistance(
      measurement.distanceMeters,
      measurement.intersects,
      warningDistance
    )
    if (!level) continue

    best = preferObservation(best, {
      robotId: snapshot.robotId,
      level,
      kind: 'obstacle',
      confirmationKey: `obstacle:${snapshot.robotId}:${obstacle.objectId}`,
      signature: `obstacle:${obstacle.objectId}:${linkName}`,
      counterpartRobotIds: [],
      objectIds: [obstacle.objectId],
      distanceMeters: measurement.distanceMeters,
      message:
        level === 'collision'
          ? `Robot link ${linkName} intersects obstacle ${obstacle.objectId}.`
          : `Robot link ${linkName} is near obstacle ${obstacle.objectId}.`,
      source: measurement.intersects ? 'exact-intersection' : 'exact-distance'
    })
  }
  return best
}

function detectRobotPairContact(
  left: RobotLinkObbSnapshot,
  right: RobotLinkObbSnapshot,
  leftRobot: CollisionRobotSnapshot | undefined,
  rightRobot: CollisionRobotSnapshot | undefined,
  leftPolicy: RobotCollisionPolicy,
  rightPolicy: RobotCollisionPolicy,
  geometryCache: RobotCollisionGeometryCache,
  exactWorkBudget: ExactCollisionWorkBudget
): { left: CollisionObservation | null; right: CollisionObservation | null } {
  if (!leftRobot || !rightRobot) return { left: null, right: null }
  let leftBest: CollisionObservation | null = null
  let rightBest: CollisionObservation | null = null
  const maxWarningDistance = Math.max(
    leftPolicy.thresholds.robotWarningDistanceMeters,
    rightPolicy.thresholds.robotWarningDistanceMeters
  )
  const approachDistance =
    leftPolicy.thresholds.robotApproachZoneRadiusMeters +
    rightPolicy.thresholds.robotApproachZoneRadiusMeters
  const originDistance = horizontalRobotOriginDistance(leftRobot, rightRobot)
  const approachZonesTouch = approachDistance > 0 && originDistance <= approachDistance

  if (approachZonesTouch) {
    leftBest = createRobotApproachObservation(left.robotId, right.robotId, originDistance)
    rightBest = createRobotApproachObservation(right.robotId, left.robotId, originDistance)
  }

  // Once the cheap base zones already provide an orange proximity warning, exact robot-pair
  // work only needs to answer the safety-critical intersection question. Passing zero skips the
  // expensive closest-surface search while keeping BVH intersection checks for red collision.
  const exactSearchDistance = approachZonesTouch ? 0 : maxWarningDistance
  const candidates: Array<{
    leftLinkName: string
    rightLinkName: string
    approximateDistance: number
  }> = []

  for (const [leftLinkName, leftObb] of left.linkObbs) {
    if (matchesAnyPattern(leftLinkName, leftPolicy.geometry.robotPairIgnoredLinkPatterns)) continue
    for (const [rightLinkName, rightObb] of right.linkObbs) {
      if (matchesAnyPattern(rightLinkName, rightPolicy.geometry.robotPairIgnoredLinkPatterns))
        continue

      const approximateDistance = obbGapDistance(leftObb, rightObb)
      if (approximateDistance <= exactSearchDistance) {
        candidates.push({ leftLinkName, rightLinkName, approximateDistance })
      }
    }
  }

  // Exact BVH checks are the expensive part of a contact tick. Checking the closest OBB pairs
  // first normally finds a real mesh intersection immediately instead of spending the global
  // budget on unrelated links. Once one exact intersection is found, no later pair can produce
  // a stronger result than collision, so return without scanning the remaining links.
  candidates.sort(
    (leftCandidate, rightCandidate) =>
      leftCandidate.approximateDistance - rightCandidate.approximateDistance
  )

  for (const { leftLinkName, rightLinkName } of candidates) {
    const probe = geometryCache.probeLinkPairExact(
      leftRobot,
      leftLinkName,
      rightRobot,
      rightLinkName,
      exactSearchDistance,
      exactWorkBudget
    )
    if (probe === null) continue
    if (probe.status === 'pending') continue
    const measurement = probe.measurement
    const leftLevel = classifyExactDistance(
      measurement.distanceMeters,
      measurement.intersects,
      leftPolicy.thresholds.robotWarningDistanceMeters
    )
    const rightLevel = classifyExactDistance(
      measurement.distanceMeters,
      measurement.intersects,
      rightPolicy.thresholds.robotWarningDistanceMeters
    )

    if (leftLevel) {
      leftBest = preferObservation(leftBest, {
        robotId: left.robotId,
        level: leftLevel,
        kind: 'robot',
        confirmationKey: createRobotPairConfirmationKey(left.robotId, right.robotId),
        signature: `robot:${right.robotId}:${leftLinkName}:${rightLinkName}`,
        counterpartRobotIds: [right.robotId],
        objectIds: [],
        distanceMeters: measurement.distanceMeters,
        message: buildRobotPairMessage(leftLevel, right.robotId, leftLinkName, rightLinkName),
        source: measurement.intersects ? 'exact-intersection' : 'exact-distance'
      })
    }
    if (rightLevel) {
      rightBest = preferObservation(rightBest, {
        robotId: right.robotId,
        level: rightLevel,
        kind: 'robot',
        confirmationKey: createRobotPairConfirmationKey(right.robotId, left.robotId),
        signature: `robot:${left.robotId}:${rightLinkName}:${leftLinkName}`,
        counterpartRobotIds: [left.robotId],
        objectIds: [],
        distanceMeters: measurement.distanceMeters,
        message: buildRobotPairMessage(rightLevel, left.robotId, rightLinkName, leftLinkName),
        source: measurement.intersects ? 'exact-intersection' : 'exact-distance'
      })
    }

    if (measurement.intersects && leftBest && rightBest) {
      return { left: leftBest, right: rightBest }
    }
  }

  return { left: leftBest, right: rightBest }
}

function createRobotApproachObservation(
  robotId: string,
  counterpartRobotId: string,
  originDistanceMeters: number
): CollisionObservation {
  return {
    robotId,
    level: 'proximity',
    kind: 'robot',
    confirmationKey: createRobotPairConfirmationKey(robotId, counterpartRobotId),
    signature: `robot:${counterpartRobotId}:approach-zone`,
    counterpartRobotIds: [counterpartRobotId],
    objectIds: [],
    distanceMeters: 0,
    message: `Robot base approach zone touches robot ${counterpartRobotId} at ${Math.round(
      originDistanceMeters * 1000
    )} mm center distance.`,
    source: 'robot-approach-zone'
  }
}

function horizontalRobotOriginDistance(
  leftRobot: CollisionRobotSnapshot,
  rightRobot: CollisionRobotSnapshot
): number {
  const leftElements = leftRobot.object.matrixWorld.elements
  const rightElements = rightRobot.object.matrixWorld.elements
  return Math.hypot(leftElements[12] - rightElements[12], leftElements[14] - rightElements[14])
}

function buildRobotPairMessage(
  level: 'proximity' | 'collision',
  counterpartRobotId: string,
  ownLinkName: string,
  counterpartLinkName: string
): string {
  return level === 'collision'
    ? `Robot link ${ownLinkName} intersects robot ${counterpartRobotId} link ${counterpartLinkName}.`
    : `Robot link ${ownLinkName} is near robot ${counterpartRobotId} link ${counterpartLinkName}.`
}

function classifyExactDistance(
  distanceMeters: number,
  intersects: boolean,
  warningDistanceMeters: number
): 'proximity' | 'collision' | null {
  if (intersects) return 'collision'
  if (warningDistanceMeters > 0 && distanceMeters <= warningDistanceMeters) return 'proximity'
  return null
}

function appendObservation(
  observations: Map<string, CollisionObservation[]>,
  candidate: CollisionObservation | null
): void {
  if (!candidate) return
  const robotObservations = observations.get(candidate.robotId) ?? []
  const sameKeyIndex = robotObservations.findIndex(
    (observation) => observation.confirmationKey === candidate.confirmationKey
  )
  if (sameKeyIndex < 0) {
    robotObservations.push(candidate)
  } else {
    robotObservations[sameKeyIndex] = preferObservation(robotObservations[sameKeyIndex], candidate)
  }
  observations.set(candidate.robotId, robotObservations)
}

function preferObservation(
  current: CollisionObservation | null,
  candidate: CollisionObservation
): CollisionObservation {
  if (!current) return candidate
  if (current.level !== candidate.level)
    return candidate.level === 'collision' ? candidate : current
  return candidate.distanceMeters < current.distanceMeters ? candidate : current
}

function matchesAnyPattern(linkName: string, patterns: readonly string[]): boolean {
  const normalized = linkName.toLowerCase()
  return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()))
}

function createRobotPairConfirmationKey(leftRobotId: string, rightRobotId: string): string {
  return `robot:${[leftRobotId, rightRobotId].sort().join(':')}`
}

function rotateItems<T>(items: readonly T[], offset: number): readonly T[] {
  if (items.length < 2) return items
  const normalizedOffset = ((offset % items.length) + items.length) % items.length
  if (normalizedOffset === 0) return items
  return [...items.slice(normalizedOffset), ...items.slice(0, normalizedOffset)]
}

function obbGapDistance(left: OBB, right: OBB): number {
  if (left.intersectsOBB(right)) return 0
  return box3GapDistance(obbToBox3(left), obbToBox3(right))
}

function obbBoxGapDistance(obb: OBB, box: THREE.Box3): number {
  if (obb.intersectsBox3(box)) return 0
  return box3GapDistance(obbToBox3(obb), box)
}

function box3GapDistance(left: THREE.Box3, right: THREE.Box3): number {
  const dx = Math.max(left.min.x - right.max.x, right.min.x - left.max.x, 0)
  const dy = Math.max(left.min.y - right.max.y, right.min.y - left.max.y, 0)
  const dz = Math.max(left.min.z - right.max.z, right.min.z - left.max.z, 0)
  return Math.hypot(dx, dy, dz)
}

function findLinkObb(linkObbs: ReadonlyMap<string, OBB>, pattern: string): OBB | undefined {
  const direct = linkObbs.get(pattern)
  if (direct) return direct
  const normalizedPattern = pattern.toLowerCase()
  for (const [linkName, obb] of linkObbs) {
    if (linkName.toLowerCase().includes(normalizedPattern)) return obb
  }
  return undefined
}

function obbToBox3(obb: OBB): THREE.Box3 {
  const box = new THREE.Box3()
  const elements = obb.rotation.elements
  const axisX = new THREE.Vector3(elements[0], elements[1], elements[2])
  const axisY = new THREE.Vector3(elements[3], elements[4], elements[5])
  const axisZ = new THREE.Vector3(elements[6], elements[7], elements[8])
  const point = new THREE.Vector3()

  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        point.copy(obb.center)
        point.addScaledVector(axisX, obb.halfSize.x * x)
        point.addScaledVector(axisY, obb.halfSize.y * y)
        point.addScaledVector(axisZ, obb.halfSize.z * z)
        box.expandByPoint(point)
      }
    }
  }
  return box
}
