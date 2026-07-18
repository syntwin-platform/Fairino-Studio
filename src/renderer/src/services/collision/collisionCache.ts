import * as THREE from 'three'
import { OBB } from 'three/examples/jsm/math/OBB.js'
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh'

import type {
  CachedObstacleBounds,
  CollisionLocalPoint,
  CollisionObstacleSnapshot,
  CollisionRobotSnapshot,
  RobotLinkCollisionGeometry,
  RobotLinkObbSnapshot
} from './collisionTypes'

interface ObstacleCacheEntry extends CachedObstacleBounds {
  sourceObject: THREE.Object3D
}

interface RobotGeometryCacheEntry {
  sourceObject: THREE.Object3D
  linkObjects: Record<string, THREE.Object3D>
  links: Map<string, RobotLinkCollisionGeometry>
  bounds: THREE.Box3
  boundsRevision: number
  poseSignature: number[] | null
  linkSnapshot: RobotLinkObbSnapshot | null
}

interface CollisionMeshPart {
  meshObject: THREE.Mesh
  geometry: THREE.BufferGeometry
}

type CollisionBufferGeometry = THREE.BufferGeometry & {
  boundsTree?: MeshBVH
}

export interface ExactCollisionMeasurement {
  intersects: boolean
  distanceMeters: number
}

export interface ExactCollisionWorkBudget {
  remainingMeasurements: number
}

export type ExactCollisionProbe =
  | { status: 'pending' }
  | { status: 'resolved'; measurement: ExactCollisionMeasurement }

interface ExactCollisionCacheEntry {
  signature: string
  measurement: ExactCollisionMeasurement
}

// FR5 instances load separate BufferGeometry objects with identical STL data. Sharing the BVH
// by a content fingerprint avoids rebuilding the same six link trees for every robot and mode.
const SHARED_BVH_BY_FINGERPRINT = new Map<string, MeshBVH>()

export interface ObstacleBoundsSyncResult {
  bounds: CachedObstacleBounds[]
  changed: boolean
}

export class ObstacleBoundsCache {
  private readonly entries = new Map<string, ObstacleCacheEntry>()

  sync(obstacles: readonly CollisionObstacleSnapshot[]): ObstacleBoundsSyncResult {
    const visibleIds = new Set<string>()
    const bounds: CachedObstacleBounds[] = []
    let changed = false

    for (const obstacle of obstacles) {
      if (!obstacle.visible) continue

      visibleIds.add(obstacle.objectId)
      const cached = this.entries.get(obstacle.objectId)
      if (
        !cached ||
        cached.sourceObject !== obstacle.object ||
        cached.transformRevision !== obstacle.transformRevision
      ) {
        obstacle.object.updateWorldMatrix(true, true)
        const next: ObstacleCacheEntry = {
          objectId: obstacle.objectId,
          object: obstacle.object,
          sourceObject: obstacle.object,
          transformRevision: obstacle.transformRevision,
          box: new THREE.Box3().setFromObject(obstacle.object)
        }
        this.entries.set(obstacle.objectId, next)
        bounds.push(next)
        changed = true
      } else {
        bounds.push(cached)
      }
    }

    for (const objectId of this.entries.keys()) {
      if (!visibleIds.has(objectId)) {
        this.entries.delete(objectId)
        changed = true
      }
    }

    return { bounds, changed }
  }

  clear(): void {
    this.entries.clear()
  }
}

export class RobotCollisionGeometryCache {
  private readonly entries = new Map<string, RobotGeometryCacheEntry>()
  private readonly meshPartsByLinkObject = new WeakMap<THREE.Object3D, CollisionMeshPart[]>()
  private readonly meshPartsByObject = new WeakMap<THREE.Object3D, CollisionMeshPart[]>()
  private readonly bvhByGeometry = new WeakMap<THREE.BufferGeometry, MeshBVH>()
  private readonly fingerprintByGeometry = new WeakMap<THREE.BufferGeometry, string>()
  private readonly exactMeasurements = new Map<string, ExactCollisionCacheEntry>()
  private geometryRevision = 0

  updateBounds(robot: CollisionRobotSnapshot): THREE.Box3 {
    return this.updateBoundsWithStatus(robot).bounds
  }

  updateBoundsWithStatus(robot: CollisionRobotSnapshot): {
    bounds: THREE.Box3
    changed: boolean
  } {
    const entry = this.getOrCreateEntry(robot)
    const poseSignature = captureRobotPoseSignature(entry)
    if (entry.poseSignature && poseSignaturesEqual(entry.poseSignature, poseSignature)) {
      return { bounds: entry.bounds, changed: false }
    }

    entry.bounds.setFromObject(robot.object)
    entry.boundsRevision += 1
    entry.poseSignature = poseSignature
    entry.linkSnapshot = null
    return { bounds: entry.bounds, changed: true }
  }

  getBounds(robotId: string): THREE.Box3 | null {
    return this.entries.get(robotId)?.bounds ?? null
  }

  prewarmExactGeometry(
    robot: CollisionRobotSnapshot,
    maxNewTrees = 1
  ): { complete: boolean; preparedTreeCount: number } {
    const entry = this.getOrCreateEntry(robot)
    let preparedTreeCount = 0

    for (const link of entry.links.values()) {
      for (const part of this.getLinkMeshParts(link, robot)) {
        if (this.bvhByGeometry.has(part.geometry)) continue
        this.prepareBvh(part.geometry)
        preparedTreeCount += 1
        if (preparedTreeCount >= Math.max(1, maxNewTrees)) {
          return {
            complete: [...entry.links.values()].every((candidateLink) =>
              this.areMeshPartsPrepared(this.getLinkMeshParts(candidateLink, robot))
            ),
            preparedTreeCount
          }
        }
      }
    }

    return { complete: true, preparedTreeCount }
  }

  prewarmObjectExactGeometry(
    object: THREE.Object3D,
    maxNewTrees = 1
  ): { complete: boolean; preparedTreeCount: number } {
    return this.prewarmMeshParts(this.getObjectMeshParts(object), maxNewTrees)
  }

  isExactGeometryReady(robot: CollisionRobotSnapshot): boolean {
    const entry = this.getOrCreateEntry(robot)
    for (const link of entry.links.values()) {
      if (!this.areMeshPartsPrepared(this.getLinkMeshParts(link, robot))) return false
    }
    return entry.links.size > 0
  }

  isObjectExactGeometryReady(object: THREE.Object3D): boolean {
    const parts = this.getObjectMeshParts(object)
    return parts.length > 0 && this.areMeshPartsPrepared(parts)
  }

  buildLinkObbSnapshot(robot: CollisionRobotSnapshot): RobotLinkObbSnapshot {
    const entry = this.getOrCreateEntry(robot)
    if (entry.linkSnapshot) return entry.linkSnapshot

    const linkObbs = new Map<string, OBB>()
    const linkWorldPoints = new Map<string, THREE.Vector3>()

    for (const geometry of entry.links.values()) {
      const worldMatrix = geometry.linkObject.matrixWorld
      const center = geometry.localBox.getCenter(new THREE.Vector3()).applyMatrix4(worldMatrix)
      const localHalfSize = geometry.localBox.getSize(new THREE.Vector3()).multiplyScalar(0.5)
      const scale = new THREE.Vector3()
      worldMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale)
      const rotation = new THREE.Matrix3().setFromMatrix4(worldMatrix)
      normalizeRotationColumns(rotation)

      linkObbs.set(
        geometry.linkName,
        new OBB(
          center,
          localHalfSize.multiply(
            new THREE.Vector3(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z))
          ),
          rotation
        )
      )
      linkWorldPoints.set(
        geometry.linkName,
        geometry.linkObject.getWorldPosition(new THREE.Vector3())
      )
    }

    entry.linkSnapshot = {
      robotId: robot.robotId,
      robotObject: robot.object,
      robotBounds: entry.bounds,
      linkObbs,
      linkWorldPoints
    }
    return entry.linkSnapshot
  }

  getExactMinimumWorldY(robot: CollisionRobotSnapshot, linkName: string): number | null {
    const entry = this.getOrCreateEntry(robot)
    const geometry = entry.links.get(linkName)
    if (!geometry) return null

    if (geometry.localGroundVertices === null) {
      geometry.localGroundVertices = collectLocalGroundVertices(
        geometry.linkObject,
        new Set(Object.values(robot.links))
      )
    }

    if (geometry.localGroundVertices.length === 0) return null

    const point = new THREE.Vector3()
    let minimumY = Number.POSITIVE_INFINITY
    for (const localPoint of geometry.localGroundVertices) {
      point.set(localPoint.x, localPoint.y, localPoint.z)
      point.applyMatrix4(geometry.linkObject.matrixWorld)
      minimumY = Math.min(minimumY, point.y)
    }

    return Number.isFinite(minimumY) ? minimumY : null
  }

  intersectsLinkPairExact(
    leftRobot: CollisionRobotSnapshot,
    leftLinkName: string,
    rightRobot: CollisionRobotSnapshot,
    rightLinkName: string
  ): boolean | null {
    const leftLink = this.findLinkGeometry(leftRobot, leftLinkName)
    const rightLink = this.findLinkGeometry(rightRobot, rightLinkName)
    if (!leftLink || !rightLink) return null

    const leftParts = this.getLinkMeshParts(leftLink, leftRobot)
    const rightParts = this.getLinkMeshParts(rightLink, rightRobot)
    return this.intersectsMeshPartsExact(leftParts, rightParts)
  }

  measureLinkPairExact(
    leftRobot: CollisionRobotSnapshot,
    leftLinkName: string,
    rightRobot: CollisionRobotSnapshot,
    rightLinkName: string,
    maxDistanceMeters: number
  ): ExactCollisionMeasurement | null {
    const leftLink = this.findLinkGeometry(leftRobot, leftLinkName)
    const rightLink = this.findLinkGeometry(rightRobot, rightLinkName)
    if (!leftLink || !rightLink) return null

    const leftParts = this.getLinkMeshParts(leftLink, leftRobot)
    const rightParts = this.getLinkMeshParts(rightLink, rightRobot)
    return this.measureMeshPartsExact(leftParts, rightParts, maxDistanceMeters)
  }

  probeLinkPairExact(
    leftRobot: CollisionRobotSnapshot,
    leftLinkName: string,
    rightRobot: CollisionRobotSnapshot,
    rightLinkName: string,
    maxDistanceMeters: number,
    budget: ExactCollisionWorkBudget
  ): ExactCollisionProbe | null {
    const leftLink = this.findLinkGeometry(leftRobot, leftLinkName)
    const rightLink = this.findLinkGeometry(rightRobot, rightLinkName)
    if (!leftLink || !rightLink) return null

    const leftParts = this.getLinkMeshParts(leftLink, leftRobot)
    const rightParts = this.getLinkMeshParts(rightLink, rightRobot)
    if (!this.areMeshPartsPrepared(leftParts) || !this.areMeshPartsPrepared(rightParts)) {
      return { status: 'pending' }
    }

    const cacheKey =
      `pair:${leftRobot.robotId}:${leftLink.linkName}:` +
      `${rightRobot.robotId}:${rightLink.linkName}:${maxDistanceMeters}`
    const signature = `${createMatrixSignature(leftLink.linkObject.matrixWorld)}|${createMatrixSignature(rightLink.linkObject.matrixWorld)}`

    return this.probeExactMeasurement(cacheKey, signature, budget, () =>
      this.measureMeshPartsExact(leftParts, rightParts, maxDistanceMeters)
    )
  }

  intersectsLinkObjectExact(
    robot: CollisionRobotSnapshot,
    linkName: string,
    object: THREE.Object3D
  ): boolean | null {
    const link = this.findLinkGeometry(robot, linkName)
    if (!link) return null

    const linkParts = this.getLinkMeshParts(link, robot)
    const objectParts = this.getObjectMeshParts(object)
    return this.intersectsMeshPartsExact(linkParts, objectParts)
  }

  measureLinkObjectExact(
    robot: CollisionRobotSnapshot,
    linkName: string,
    object: THREE.Object3D,
    maxDistanceMeters: number
  ): ExactCollisionMeasurement | null {
    const link = this.findLinkGeometry(robot, linkName)
    if (!link) return null

    const linkParts = this.getLinkMeshParts(link, robot)
    const objectParts = this.getObjectMeshParts(object)
    return this.measureMeshPartsExact(linkParts, objectParts, maxDistanceMeters)
  }

  probeLinkObjectExact(
    robot: CollisionRobotSnapshot,
    linkName: string,
    object: THREE.Object3D,
    maxDistanceMeters: number,
    budget: ExactCollisionWorkBudget
  ): ExactCollisionProbe | null {
    const link = this.findLinkGeometry(robot, linkName)
    if (!link) return null

    const linkParts = this.getLinkMeshParts(link, robot)
    const objectParts = this.getObjectMeshParts(object)
    if (!this.areMeshPartsPrepared(linkParts) || !this.areMeshPartsPrepared(objectParts)) {
      return { status: 'pending' }
    }

    const cacheKey = `object:${robot.robotId}:${link.linkName}:${object.uuid}:${maxDistanceMeters}`
    const signature = `${createMatrixSignature(link.linkObject.matrixWorld)}|${createMatrixSignature(object.matrixWorld)}`

    return this.probeExactMeasurement(cacheKey, signature, budget, () =>
      this.measureMeshPartsExact(linkParts, objectParts, maxDistanceMeters)
    )
  }

  removeMissing(robotIds: ReadonlySet<string>): string[] {
    const removed: string[] = []
    for (const robotId of this.entries.keys()) {
      if (!robotIds.has(robotId)) {
        this.entries.delete(robotId)
        this.removeExactMeasurementsForRobot(robotId)
        removed.push(robotId)
      }
    }
    return removed
  }

  remove(robotId: string): void {
    this.entries.delete(robotId)
    this.removeExactMeasurementsForRobot(robotId)
  }

  clear(): void {
    this.entries.clear()
    this.exactMeasurements.clear()
  }

  private probeExactMeasurement(
    cacheKey: string,
    signature: string,
    budget: ExactCollisionWorkBudget,
    measure: () => ExactCollisionMeasurement | null
  ): ExactCollisionProbe {
    const cached = this.exactMeasurements.get(cacheKey)
    if (cached?.signature === signature) {
      return { status: 'resolved', measurement: cached.measurement }
    }

    if (budget.remainingMeasurements <= 0) return { status: 'pending' }
    budget.remainingMeasurements -= 1

    const measurement = measure()
    if (!measurement) return { status: 'pending' }

    this.storeExactMeasurement(cacheKey, signature, measurement)
    return { status: 'resolved', measurement }
  }

  private storeExactMeasurement(
    cacheKey: string,
    signature: string,
    measurement: ExactCollisionMeasurement
  ): void {
    this.exactMeasurements.set(cacheKey, { signature, measurement })
    if (this.exactMeasurements.size > 512) {
      const oldestKey = this.exactMeasurements.keys().next().value
      if (oldestKey) this.exactMeasurements.delete(oldestKey)
    }
  }

  private removeExactMeasurementsForRobot(robotId: string): void {
    const marker = `:${robotId}:`
    for (const key of this.exactMeasurements.keys()) {
      if (key.includes(marker)) this.exactMeasurements.delete(key)
    }
  }

  private getOrCreateEntry(robot: CollisionRobotSnapshot): RobotGeometryCacheEntry {
    const cached = this.entries.get(robot.robotId)
    if (
      cached &&
      cached.sourceObject === robot.object &&
      shallowObjectMapEqual(cached.linkObjects, robot.links) &&
      cached.links.size > 0
    ) {
      return cached
    }

    const allLinkObjects = new Set(Object.values(robot.links))
    const links = new Map<string, RobotLinkCollisionGeometry>()
    for (const [linkName, linkObject] of Object.entries(robot.links)) {
      const localBox = computeLinkLocalBox(linkObject, allLinkObjects)
      if (!localBox || localBox.isEmpty()) continue
      links.set(linkName, {
        linkName,
        linkObject,
        localBox,
        localGroundVertices: null
      })
    }

    this.geometryRevision += 1
    const entry: RobotGeometryCacheEntry = {
      sourceObject: robot.object,
      linkObjects: { ...robot.links },
      links,
      bounds: new THREE.Box3().setFromObject(robot.object),
      boundsRevision: this.geometryRevision,
      poseSignature: null,
      linkSnapshot: null
    }
    this.entries.set(robot.robotId, entry)
    return entry
  }

  private findLinkGeometry(
    robot: CollisionRobotSnapshot,
    linkPattern: string
  ): RobotLinkCollisionGeometry | null {
    const entry = this.getOrCreateEntry(robot)
    const direct = entry.links.get(linkPattern)
    if (direct) return direct

    const normalizedPattern = linkPattern.toLowerCase()
    for (const [linkName, geometry] of entry.links) {
      if (linkName.toLowerCase().includes(normalizedPattern)) return geometry
    }
    return null
  }

  private getLinkMeshParts(
    link: RobotLinkCollisionGeometry,
    robot: CollisionRobotSnapshot
  ): CollisionMeshPart[] {
    const cached = this.meshPartsByLinkObject.get(link.linkObject)
    if (cached) return cached

    const parts = collectMeshParts(link.linkObject, new Set(Object.values(robot.links)))
    this.meshPartsByLinkObject.set(link.linkObject, parts)
    return parts
  }

  private getObjectMeshParts(object: THREE.Object3D): CollisionMeshPart[] {
    const cached = this.meshPartsByObject.get(object)
    if (cached) return cached

    const parts = collectMeshParts(object, new Set())
    this.meshPartsByObject.set(object, parts)
    return parts
  }

  private prewarmMeshParts(
    parts: readonly CollisionMeshPart[],
    maxNewTrees: number
  ): { complete: boolean; preparedTreeCount: number } {
    let preparedTreeCount = 0
    for (const part of parts) {
      if (this.bvhByGeometry.has(part.geometry)) continue
      this.prepareBvh(part.geometry)
      preparedTreeCount += 1
      if (preparedTreeCount >= Math.max(1, maxNewTrees)) {
        return {
          complete: parts.every((candidate) => this.bvhByGeometry.has(candidate.geometry)),
          preparedTreeCount
        }
      }
    }
    return { complete: true, preparedTreeCount }
  }

  private areMeshPartsPrepared(parts: readonly CollisionMeshPart[]): boolean {
    return parts.length > 0 && parts.every((part) => this.bvhByGeometry.has(part.geometry))
  }

  private intersectsMeshPartsExact(
    leftParts: readonly CollisionMeshPart[],
    rightParts: readonly CollisionMeshPart[]
  ): boolean | null {
    if (leftParts.length === 0 || rightParts.length === 0) return null

    const rightToLeft = new THREE.Matrix4()
    const inverseLeft = new THREE.Matrix4()

    for (const left of leftParts) {
      const bvh = this.getOrCreateBvh(left.geometry)
      inverseLeft.copy(left.meshObject.matrixWorld).invert()

      for (const right of rightParts) {
        rightToLeft.multiplyMatrices(inverseLeft, right.meshObject.matrixWorld)
        this.getOrCreateBvh(right.geometry)
        if (bvh.intersectsGeometry(right.geometry, rightToLeft)) {
          return true
        }
      }
    }

    return false
  }

  private measureMeshPartsExact(
    leftParts: readonly CollisionMeshPart[],
    rightParts: readonly CollisionMeshPart[],
    maxDistanceMeters: number
  ): ExactCollisionMeasurement | null {
    if (leftParts.length === 0 || rightParts.length === 0) return null

    const boundedMaxDistance = Math.max(0, maxDistanceMeters)
    const rightToLeft = new THREE.Matrix4()
    const inverseLeft = new THREE.Matrix4()
    const leftWorldPoint = new THREE.Vector3()
    const rightWorldPoint = new THREE.Vector3()
    const leftWorldScale = new THREE.Vector3()
    let minimumDistanceMeters = Number.POSITIVE_INFINITY

    for (const left of leftParts) {
      const bvh = this.getOrCreateBvh(left.geometry)
      inverseLeft.copy(left.meshObject.matrixWorld).invert()
      left.meshObject.getWorldScale(leftWorldScale)
      const minimumWorldScale = Math.max(
        1e-9,
        Math.min(Math.abs(leftWorldScale.x), Math.abs(leftWorldScale.y), Math.abs(leftWorldScale.z))
      )
      const maxDistanceInLeftSpace = boundedMaxDistance / minimumWorldScale

      for (const right of rightParts) {
        rightToLeft.multiplyMatrices(inverseLeft, right.meshObject.matrixWorld)
        this.getOrCreateBvh(right.geometry)

        if (bvh.intersectsGeometry(right.geometry, rightToLeft)) {
          return { intersects: true, distanceMeters: 0 }
        }

        const leftTarget = {} as HitPointInfo
        const rightTarget = {} as HitPointInfo
        const result = bvh.closestPointToGeometry(
          right.geometry,
          rightToLeft,
          leftTarget,
          rightTarget,
          0,
          maxDistanceInLeftSpace
        )
        if (!result?.point || !rightTarget.point) continue

        leftWorldPoint.copy(result.point).applyMatrix4(left.meshObject.matrixWorld)
        rightWorldPoint.copy(rightTarget.point).applyMatrix4(right.meshObject.matrixWorld)
        const distanceMeters = leftWorldPoint.distanceTo(rightWorldPoint)
        minimumDistanceMeters = Math.min(minimumDistanceMeters, distanceMeters)

        if (minimumDistanceMeters <= 1e-6) {
          return { intersects: true, distanceMeters: 0 }
        }
      }
    }

    return {
      intersects: false,
      distanceMeters: minimumDistanceMeters
    }
  }

  private getOrCreateBvh(geometry: THREE.BufferGeometry): MeshBVH {
    return this.prepareBvh(geometry).bvh
  }

  private prepareBvh(geometry: THREE.BufferGeometry): {
    bvh: MeshBVH
    builtNewTree: boolean
  } {
    const cached = this.bvhByGeometry.get(geometry)
    if (cached) {
      ;(geometry as CollisionBufferGeometry).boundsTree = cached
      return { bvh: cached, builtNewTree: false }
    }

    let fingerprint = this.fingerprintByGeometry.get(geometry)
    if (!fingerprint) {
      fingerprint = createGeometryFingerprint(geometry)
      this.fingerprintByGeometry.set(geometry, fingerprint)
    }
    const shared = SHARED_BVH_BY_FINGERPRINT.get(fingerprint)
    if (shared) {
      this.bvhByGeometry.set(geometry, shared)
      ;(geometry as CollisionBufferGeometry).boundsTree = shared
      return { bvh: shared, builtNewTree: false }
    }

    const bvh = new MeshBVH(geometry, {
      targetLeafSize: 20,
      indirect: true,
      verbose: false
    })
    this.bvhByGeometry.set(geometry, bvh)
    ;(geometry as CollisionBufferGeometry).boundsTree = bvh
    if (SHARED_BVH_BY_FINGERPRINT.size >= 64) {
      const oldestFingerprint = SHARED_BVH_BY_FINGERPRINT.keys().next().value
      if (oldestFingerprint) SHARED_BVH_BY_FINGERPRINT.delete(oldestFingerprint)
    }
    SHARED_BVH_BY_FINGERPRINT.set(fingerprint, bvh)
    return { bvh, builtNewTree: true }
  }
}

function computeLinkLocalBox(
  linkObject: THREE.Object3D,
  allLinkObjects: ReadonlySet<THREE.Object3D>
): THREE.Box3 | null {
  linkObject.updateWorldMatrix(true, true)
  const inverseLinkWorld = linkObject.matrixWorld.clone().invert()
  const localBox = new THREE.Box3()
  const meshBox = new THREE.Box3()
  let hasGeometry = false

  const visit = (object: THREE.Object3D): void => {
    if (object !== linkObject && allLinkObjects.has(object)) return

    const mesh = object as THREE.Mesh
    if (mesh.isMesh && mesh.geometry) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      if (mesh.geometry.boundingBox) {
        meshBox.copy(mesh.geometry.boundingBox)
        meshBox.applyMatrix4(mesh.matrixWorld)
        meshBox.applyMatrix4(inverseLinkWorld)
        localBox.union(meshBox)
        hasGeometry = true
      }
    }

    for (const child of object.children) visit(child)
  }

  visit(linkObject)
  return hasGeometry ? localBox : null
}

function collectLocalGroundVertices(
  linkObject: THREE.Object3D,
  allLinkObjects: ReadonlySet<THREE.Object3D>
): CollisionLocalPoint[] {
  linkObject.updateWorldMatrix(true, true)
  const inverseLinkWorld = linkObject.matrixWorld.clone().invert()
  const point = new THREE.Vector3()
  const vertices = new Map<string, CollisionLocalPoint>()

  const visit = (object: THREE.Object3D): void => {
    if (object !== linkObject && allLinkObjects.has(object)) return

    const mesh = object as THREE.Mesh
    const position = mesh.isMesh ? mesh.geometry?.getAttribute('position') : null
    if (position) {
      const meshToLink = inverseLinkWorld.clone().multiply(mesh.matrixWorld)
      for (let index = 0; index < position.count; index += 1) {
        point.fromBufferAttribute(position, index).applyMatrix4(meshToLink)
        const key =
          `${Math.round(point.x * 1_000_000)}:` +
          `${Math.round(point.y * 1_000_000)}:` +
          `${Math.round(point.z * 1_000_000)}`
        if (!vertices.has(key)) vertices.set(key, { x: point.x, y: point.y, z: point.z })
      }
    }

    for (const child of object.children) visit(child)
  }

  visit(linkObject)
  return [...vertices.values()]
}

function normalizeRotationColumns(rotation: THREE.Matrix3): void {
  const elements = rotation.elements
  for (let column = 0; column < 3; column += 1) {
    const offset = column * 3
    const length = Math.hypot(elements[offset], elements[offset + 1], elements[offset + 2]) || 1
    elements[offset] /= length
    elements[offset + 1] /= length
    elements[offset + 2] /= length
  }
}

function collectMeshParts(
  root: THREE.Object3D,
  nestedLinkObjects: ReadonlySet<THREE.Object3D>
): CollisionMeshPart[] {
  root.updateWorldMatrix(true, true)
  const parts: CollisionMeshPart[] = []

  const visit = (object: THREE.Object3D): void => {
    if (object !== root && nestedLinkObjects.has(object)) return

    const mesh = object as THREE.Mesh
    const position = mesh.isMesh ? mesh.geometry?.getAttribute('position') : null
    if (mesh.isMesh && mesh.geometry && position && position.count >= 3) {
      parts.push({ meshObject: mesh, geometry: mesh.geometry })
    }

    for (const child of object.children) visit(child)
  }

  visit(root)
  return parts
}

function shallowObjectMapEqual(
  left: Record<string, THREE.Object3D>,
  right: Record<string, THREE.Object3D>
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => left[key] === right[key])
}

function captureRobotPoseSignature(entry: RobotGeometryCacheEntry): number[] {
  const signature: number[] = []
  appendMatrixSignature(signature, entry.sourceObject.matrixWorld)
  for (const geometry of entry.links.values()) {
    appendMatrixSignature(signature, geometry.linkObject.matrixWorld)
  }
  return signature
}

function appendMatrixSignature(target: number[], matrix: THREE.Matrix4): void {
  for (const value of matrix.elements) target.push(Math.round(value * 100_000))
}

function poseSignaturesEqual(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function createMatrixSignature(matrix: THREE.Matrix4): string {
  return matrix.elements.map((value) => Math.round(value * 100_000)).join(',')
}

function createGeometryFingerprint(geometry: THREE.BufferGeometry): string {
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  let hashA = 2166136261
  let hashB = 2246822519

  const mix = (value: number): void => {
    const quantized = Math.round(value * 1_000_000)
    hashA = Math.imul(hashA ^ quantized, 16777619)
    hashB = Math.imul(hashB ^ quantized, 3266489917)
  }

  for (let item = 0; item < position.count; item += 1) {
    for (let component = 0; component < position.itemSize; component += 1) {
      mix(position.array[item * position.itemSize + component])
    }
  }
  if (index) {
    for (let item = 0; item < index.count; item += 1) mix(index.getX(item))
  }

  return `${position.count}:${position.itemSize}:${index?.count ?? 0}:${hashA >>> 0}:${hashB >>> 0}`
}
