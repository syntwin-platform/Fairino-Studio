import * as THREE from 'three'
import type { OBB } from 'three/examples/jsm/math/OBB.js'

import type { RobotCollisionGeometryCache } from './collisionCache'
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
  getRobotPolicy: (robotId: string) => RobotCollisionPolicy
}

export function runCollisionNarrowPhase(
  options: CollisionNarrowPhaseOptions
): Map<string, CollisionObservation[]> {
  const observations = new Map<string, CollisionObservation[]>()

  for (const [robotId, linkSnapshot] of options.linkSnapshotsByRobotId) {
    const robot = options.robotsById.get(robotId)
    if (!robot) continue
    const policy = options.getRobotPolicy(robotId)

    if (
      options.primaryEvaluateRobotIds.has(robotId) &&
      options.groundCandidateRobotIds.has(robotId)
    ) {
      appendObservation(
        observations,
        detectGroundContact(robot, linkSnapshot, policy, options.geometryCache)
      )
    }
    if (options.primaryEvaluateRobotIds.has(robotId)) {
      for (const selfContact of detectSelfContacts(
        robot,
        linkSnapshot,
        policy,
        options.geometryCache
      )) {
        appendObservation(observations, selfContact)
      }

      for (const obstacle of options.obstacleCandidatesByRobotId.get(robotId) ?? []) {
        appendObservation(
          observations,
          detectObstacleContact(robot, linkSnapshot, obstacle, policy, options.geometryCache)
        )
      }
    }
  }

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
      options.geometryCache
    )
    appendObservation(observations, pair.left)
    appendObservation(observations, pair.right)
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
    if (exactMinimumY === null) continue

    const penetration = -exactMinimumY
    const isCollision = penetration > policy.thresholds.groundPenetrationToleranceMeters
    const distanceMeters = Math.max(0, exactMinimumY)
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
        : `Robot link ${linkName} is ${(distanceMeters * 1000).toFixed(1)} mm above the ground safety plane.`
    })
  }
  return best
}

function detectSelfContacts(
  robot: CollisionRobotSnapshot,
  snapshot: RobotLinkObbSnapshot,
  policy: RobotCollisionPolicy,
  geometryCache: RobotCollisionGeometryCache
): CollisionObservation[] {
  const contacts: CollisionObservation[] = []
  for (const pair of policy.geometry.selfCollisionPairs) {
    const left = findLinkObb(snapshot.linkObbs, pair.a)
    const right = findLinkObb(snapshot.linkObbs, pair.b)
    if (!left || !right) continue

    const approximateDistance = obbGapDistance(left, right)
    const warningDistance = policy.thresholds.selfWarningDistanceMeters
    if (approximateDistance > warningDistance) continue

    const intersects = geometryCache.intersectsLinkPairExact(robot, pair.a, robot, pair.b)
    if (intersects === null) continue
    const distanceMeters = intersects ? 0 : capsuleGapDistance(left, right)
    const level = classifyExactDistance(distanceMeters, intersects, warningDistance)
    if (!level) continue

    contacts.push({
      robotId: snapshot.robotId,
      level,
      kind: 'self',
      confirmationKey: `self:${snapshot.robotId}:${pair.a}:${pair.b}`,
      signature: `self:${pair.a}:${pair.b}`,
      counterpartRobotIds: [],
      objectIds: [],
      distanceMeters,
      message:
        level === 'collision'
          ? `Robot links ${pair.a} and ${pair.b} intersect.`
          : `Robot links ${pair.a} and ${pair.b} are too close.`
    })
  }
  return contacts
}

function detectObstacleContact(
  robot: CollisionRobotSnapshot,
  snapshot: RobotLinkObbSnapshot,
  obstacle: CachedObstacleBounds,
  policy: RobotCollisionPolicy,
  geometryCache: RobotCollisionGeometryCache
): CollisionObservation | null {
  let best: CollisionObservation | null = null
  for (const [linkName, linkObb] of snapshot.linkObbs) {
    const approximateDistance = obbBoxGapDistance(linkObb, obstacle.box)
    const warningDistance = policy.thresholds.obstacleWarningDistanceMeters
    if (approximateDistance > warningDistance) continue

    const intersects = geometryCache.intersectsLinkObjectExact(robot, linkName, obstacle.object)
    if (intersects === null) continue
    // AABB/OBB overlap without exact mesh contact is often empty space around an imported object.
    // Do not turn that conservative overlap into a false proximity warning.
    const distanceMeters = intersects
      ? 0
      : approximateDistance > 0
        ? approximateDistance
        : Number.POSITIVE_INFINITY
    const level = classifyExactDistance(distanceMeters, intersects, warningDistance)
    if (!level) continue

    best = preferObservation(best, {
      robotId: snapshot.robotId,
      level,
      kind: 'obstacle',
      confirmationKey: `obstacle:${snapshot.robotId}:${obstacle.objectId}`,
      signature: `obstacle:${obstacle.objectId}:${linkName}`,
      counterpartRobotIds: [],
      objectIds: [obstacle.objectId],
      distanceMeters,
      message:
        level === 'collision'
          ? `Robot link ${linkName} intersects obstacle ${obstacle.objectId}.`
          : `Robot link ${linkName} is near obstacle ${obstacle.objectId}.`
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
  geometryCache: RobotCollisionGeometryCache
): { left: CollisionObservation | null; right: CollisionObservation | null } {
  if (!leftRobot || !rightRobot) return { left: null, right: null }
  let leftBest: CollisionObservation | null = null
  let rightBest: CollisionObservation | null = null

  for (const [leftLinkName, leftObb] of left.linkObbs) {
    if (matchesAnyPattern(leftLinkName, leftPolicy.geometry.robotPairIgnoredLinkPatterns)) continue
    for (const [rightLinkName, rightObb] of right.linkObbs) {
      if (matchesAnyPattern(rightLinkName, rightPolicy.geometry.robotPairIgnoredLinkPatterns))
        continue

      const approximateDistance = obbGapDistance(leftObb, rightObb)
      const maxWarningDistance = Math.max(
        leftPolicy.thresholds.robotWarningDistanceMeters,
        rightPolicy.thresholds.robotWarningDistanceMeters
      )
      if (approximateDistance > maxWarningDistance) continue

      const intersects = geometryCache.intersectsLinkPairExact(
        leftRobot,
        leftLinkName,
        rightRobot,
        rightLinkName
      )
      if (intersects === null) continue
      const distanceMeters = intersects ? 0 : capsuleGapDistance(leftObb, rightObb)
      const leftLevel = classifyExactDistance(
        distanceMeters,
        intersects,
        leftPolicy.thresholds.robotWarningDistanceMeters
      )
      const rightLevel = classifyExactDistance(
        distanceMeters,
        intersects,
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
          distanceMeters,
          message: buildRobotPairMessage(leftLevel, right.robotId, leftLinkName, rightLinkName)
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
          distanceMeters,
          message: buildRobotPairMessage(rightLevel, left.robotId, rightLinkName, leftLinkName)
        })
      }
    }
  }

  return { left: leftBest, right: rightBest }
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

function obbGapDistance(left: OBB, right: OBB): number {
  if (left.intersectsOBB(right)) return 0
  const pointOnLeft = new THREE.Vector3()
  const pointOnRight = right.center.clone()
  for (let iteration = 0; iteration < 4; iteration += 1) {
    left.clampPoint(pointOnRight, pointOnLeft)
    right.clampPoint(pointOnLeft, pointOnRight)
  }
  return pointOnLeft.distanceTo(pointOnRight)
}

interface CollisionCapsule {
  start: THREE.Vector3
  end: THREE.Vector3
  radius: number
}

function capsuleGapDistance(left: OBB, right: OBB): number {
  const leftCapsule = obbToCapsule(left)
  const rightCapsule = obbToCapsule(right)
  return Math.max(
    0,
    segmentSegmentDistance(
      leftCapsule.start,
      leftCapsule.end,
      rightCapsule.start,
      rightCapsule.end
    ) -
      leftCapsule.radius -
      rightCapsule.radius
  )
}

function obbToCapsule(obb: OBB): CollisionCapsule {
  const halfSizes = [obb.halfSize.x, obb.halfSize.y, obb.halfSize.z]
  let majorAxisIndex = 0
  if (halfSizes[1] > halfSizes[majorAxisIndex]) majorAxisIndex = 1
  if (halfSizes[2] > halfSizes[majorAxisIndex]) majorAxisIndex = 2

  const minorHalfSizes = halfSizes.filter((_, index) => index !== majorAxisIndex)
  const radius = Math.max(...minorHalfSizes)
  const segmentHalfLength = Math.max(0, halfSizes[majorAxisIndex] - radius)
  const elements = obb.rotation.elements
  const offset = majorAxisIndex * 3
  const axis = new THREE.Vector3(
    elements[offset],
    elements[offset + 1],
    elements[offset + 2]
  ).normalize()
  const extension = axis.multiplyScalar(segmentHalfLength)

  return {
    start: obb.center.clone().sub(extension),
    end: obb.center.clone().add(extension),
    radius
  }
}

function segmentSegmentDistance(
  firstStart: THREE.Vector3,
  firstEnd: THREE.Vector3,
  secondStart: THREE.Vector3,
  secondEnd: THREE.Vector3
): number {
  const firstDirection = firstEnd.clone().sub(firstStart)
  const secondDirection = secondEnd.clone().sub(secondStart)
  const startDelta = firstStart.clone().sub(secondStart)
  const firstLengthSquared = firstDirection.lengthSq()
  const secondLengthSquared = secondDirection.lengthSq()
  const epsilon = 1e-12
  let firstParameter = 0
  let secondParameter = 0

  if (firstLengthSquared <= epsilon && secondLengthSquared <= epsilon) {
    return firstStart.distanceTo(secondStart)
  }

  if (firstLengthSquared <= epsilon) {
    secondParameter = THREE.MathUtils.clamp(
      secondDirection.dot(startDelta) / secondLengthSquared,
      0,
      1
    )
  } else {
    const firstSecondDot = firstDirection.dot(secondDirection)
    const firstDeltaDot = firstDirection.dot(startDelta)

    if (secondLengthSquared <= epsilon) {
      firstParameter = THREE.MathUtils.clamp(-firstDeltaDot / firstLengthSquared, 0, 1)
    } else {
      const secondDeltaDot = secondDirection.dot(startDelta)
      const denominator = firstLengthSquared * secondLengthSquared - firstSecondDot ** 2
      if (Math.abs(denominator) > epsilon) {
        firstParameter = THREE.MathUtils.clamp(
          (firstSecondDot * secondDeltaDot - firstDeltaDot * secondLengthSquared) / denominator,
          0,
          1
        )
      }

      secondParameter = (firstSecondDot * firstParameter + secondDeltaDot) / secondLengthSquared
      if (secondParameter < 0) {
        secondParameter = 0
        firstParameter = THREE.MathUtils.clamp(-firstDeltaDot / firstLengthSquared, 0, 1)
      } else if (secondParameter > 1) {
        secondParameter = 1
        firstParameter = THREE.MathUtils.clamp(
          (firstSecondDot - firstDeltaDot) / firstLengthSquared,
          0,
          1
        )
      }
    }
  }

  const closestOnFirst = firstStart.clone().addScaledVector(firstDirection, firstParameter)
  const closestOnSecond = secondStart.clone().addScaledVector(secondDirection, secondParameter)
  return closestOnFirst.distanceTo(closestOnSecond)
}

function obbBoxGapDistance(obb: OBB, box: THREE.Box3): number {
  if (obb.intersectsBox3(box)) return 0
  const pointOnObb = new THREE.Vector3()
  const pointOnBox = new THREE.Vector3()
  box.clampPoint(obb.center, pointOnBox)
  for (let iteration = 0; iteration < 4; iteration += 1) {
    obb.clampPoint(pointOnBox, pointOnObb)
    box.clampPoint(pointOnObb, pointOnBox)
  }
  return pointOnObb.distanceTo(pointOnBox)
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
