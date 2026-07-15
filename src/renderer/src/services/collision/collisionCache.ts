import * as THREE from 'three'
import { OBB } from 'three/examples/jsm/math/OBB.js'
import { MeshBVH } from 'three-mesh-bvh'

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
}

interface CollisionMeshPart {
  meshObject: THREE.Mesh
  geometry: THREE.BufferGeometry
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
  private geometryRevision = 0

  updateBounds(robot: CollisionRobotSnapshot): THREE.Box3 {
    const entry = this.getOrCreateEntry(robot)
    entry.bounds.setFromObject(robot.object)
    entry.boundsRevision += 1
    return entry.bounds
  }

  getBounds(robotId: string): THREE.Box3 | null {
    return this.entries.get(robotId)?.bounds ?? null
  }

  buildLinkObbSnapshot(robot: CollisionRobotSnapshot): RobotLinkObbSnapshot {
    const entry = this.getOrCreateEntry(robot)
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

    return {
      robotId: robot.robotId,
      robotObject: robot.object,
      robotBounds: entry.bounds,
      linkObbs,
      linkWorldPoints
    }
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

  removeMissing(robotIds: ReadonlySet<string>): string[] {
    const removed: string[] = []
    for (const robotId of this.entries.keys()) {
      if (!robotIds.has(robotId)) {
        this.entries.delete(robotId)
        removed.push(robotId)
      }
    }
    return removed
  }

  remove(robotId: string): void {
    this.entries.delete(robotId)
  }

  clear(): void {
    this.entries.clear()
  }

  private getOrCreateEntry(robot: CollisionRobotSnapshot): RobotGeometryCacheEntry {
    const cached = this.entries.get(robot.robotId)
    if (
      cached &&
      cached.sourceObject === robot.object &&
      shallowObjectMapEqual(cached.linkObjects, robot.links)
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
      boundsRevision: this.geometryRevision
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
        const rightBvh = this.getOrCreateBvh(right.geometry)
        if (
          bvh.bvhcast(rightBvh, rightToLeft, {
            intersectsTriangles: (leftTriangle, rightTriangle) =>
              leftTriangle.intersectsTriangle(rightTriangle)
          })
        ) {
          return true
        }
      }
    }

    return false
  }

  private getOrCreateBvh(geometry: THREE.BufferGeometry): MeshBVH {
    const cached = this.bvhByGeometry.get(geometry)
    if (cached) return cached

    const fingerprint = createGeometryFingerprint(geometry)
    const shared = SHARED_BVH_BY_FINGERPRINT.get(fingerprint)
    if (shared) {
      this.bvhByGeometry.set(geometry, shared)
      return shared
    }

    const bvh = new MeshBVH(geometry, {
      targetLeafSize: 20,
      indirect: true,
      verbose: false
    })
    this.bvhByGeometry.set(geometry, bvh)
    if (SHARED_BVH_BY_FINGERPRINT.size >= 64) {
      const oldestFingerprint = SHARED_BVH_BY_FINGERPRINT.keys().next().value
      if (oldestFingerprint) SHARED_BVH_BY_FINGERPRINT.delete(oldestFingerprint)
    }
    SHARED_BVH_BY_FINGERPRINT.set(fingerprint, bvh)
    return bvh
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
