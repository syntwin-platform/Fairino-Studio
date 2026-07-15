import type * as THREE from 'three'
import type { OBB } from 'three/examples/jsm/math/OBB.js'

export type CollisionContactLevel = 'proximity' | 'collision'
export type CollisionContactKind = 'ground' | 'self' | 'obstacle' | 'robot'
export type CollisionMonitoringMode = 'training-preview' | 'factory-active' | 'factory-static'

export interface CollisionThresholdPolicy {
  /** Warning clearance for the ground safety plane. */
  groundWarningDistanceMeters: number
  /** Warning clearance between non-adjacent links of the same robot. Zero disables proximity. */
  selfWarningDistanceMeters: number
  /** Warning clearance between links that belong to different robots. */
  robotWarningDistanceMeters: number
  /** Warning clearance between a robot link and an imported scene object. */
  obstacleWarningDistanceMeters: number
  confirmTicks: number
  clearTicks: number
  broadPhaseMarginMeters: number
  groundPenetrationToleranceMeters: number
}

export interface RobotCollisionGeometryPolicy {
  selfCollisionPairs: readonly { a: string; b: string }[]
  groundIgnoredLinkPatterns: readonly string[]
  robotPairIgnoredLinkPatterns: readonly string[]
}

export interface RobotCollisionPolicy {
  thresholds: CollisionThresholdPolicy
  geometry: RobotCollisionGeometryPolicy
}

export interface CollisionRobotSnapshot {
  robotId: string
  object: THREE.Object3D
  links: Record<string, THREE.Object3D>
  visible: boolean
  monitoringMode: CollisionMonitoringMode
}

export interface CollisionObstacleSnapshot {
  objectId: string
  object: THREE.Object3D
  visible: boolean
  transformRevision: number
}

export interface CollisionWorldSnapshot {
  robots: CollisionRobotSnapshot[]
  obstacles: CollisionObstacleSnapshot[]
}

export interface CachedObstacleBounds {
  objectId: string
  object: THREE.Object3D
  transformRevision: number
  box: THREE.Box3
}

export interface RobotLinkCollisionGeometry {
  linkName: string
  linkObject: THREE.Object3D
  localBox: THREE.Box3
  localGroundVertices: readonly CollisionLocalPoint[] | null
}

export interface CollisionLocalPoint {
  x: number
  y: number
  z: number
}

export interface RobotLinkObbSnapshot {
  robotId: string
  robotObject: THREE.Object3D
  robotBounds: THREE.Box3
  linkObbs: Map<string, OBB>
  linkWorldPoints: Map<string, THREE.Vector3>
}

export interface CollisionBroadPhaseResult {
  evaluateRobotIds: Set<string>
  groundCandidateRobotIds: Set<string>
  obstacleCandidatesByRobotId: Map<string, CachedObstacleBounds[]>
  robotPairCandidates: Array<[string, string]>
}

export interface CollisionObservation {
  robotId: string
  level: CollisionContactLevel
  kind: CollisionContactKind
  /** Stable identity used for confirm/clear hysteresis. It must not contain changing link names. */
  confirmationKey: string
  /** Detailed identity for diagnostics; it may change as the closest links change. */
  signature: string
  counterpartRobotIds: string[]
  objectIds: string[]
  distanceMeters: number
  message: string
}

export interface CollisionContactTransition {
  robotId: string
  monitoringMode: CollisionMonitoringMode
  observation: CollisionObservation | null
}

export interface CollisionEngineTickResult {
  evaluatedRobotCount: number
  narrowPhaseRobotCount: number
  obstacleCandidateCount: number
  robotPairCandidateCount: number
  transitionCount: number
  durationMs: number
}

export interface CollisionEngineOptions {
  getSnapshot: () => CollisionWorldSnapshot
  getRobotPolicy: (robotId: string) => RobotCollisionPolicy
  onContactTransition: (transition: CollisionContactTransition) => void
  now?: () => number
}

export interface CollisionSchedulerOptions {
  tick: () => void | Promise<void>
  intervalMs?: number
  onError?: (error: unknown) => void
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timerId: ReturnType<typeof setTimeout>) => void
  now?: () => number
}

export const DEFAULT_COLLISION_THRESHOLD_POLICY: CollisionThresholdPolicy = {
  // A normal FR5 pose can place wrist geometry roughly 37 mm above the floor and can keep
  // non-adjacent link shells similarly close. Those clearances are valid and must not inherit
  // the much larger robot/obstacle approach warning zone.
  groundWarningDistanceMeters: 0.005,
  selfWarningDistanceMeters: 0,
  robotWarningDistanceMeters: 0.08,
  obstacleWarningDistanceMeters: 0.08,
  confirmTicks: 3,
  clearTicks: 3,
  broadPhaseMarginMeters: 0.1,
  groundPenetrationToleranceMeters: 0.002
}

export const FAIRINO_FR5_COLLISION_POLICY: RobotCollisionPolicy = {
  thresholds: DEFAULT_COLLISION_THRESHOLD_POLICY,
  geometry: {
    // Adjacent joints are intentionally excluded. FR5's nominal STL shells also overlap for
    // upperarm↔wrist1 and forearm↔wrist3, so those pairs cannot represent physical collision.
    selfCollisionPairs: [
      { a: 'shoulder_link', b: 'forearm_link' },
      { a: 'shoulder_link', b: 'wrist1_link' },
      { a: 'shoulder_link', b: 'wrist2_link' },
      { a: 'shoulder_link', b: 'wrist3_link' },
      { a: 'upperarm_link', b: 'wrist2_link' },
      { a: 'upperarm_link', b: 'wrist3_link' }
    ],
    groundIgnoredLinkPatterns: ['base_link', 'shoulder_link'],
    robotPairIgnoredLinkPatterns: ['base_link']
  }
}
