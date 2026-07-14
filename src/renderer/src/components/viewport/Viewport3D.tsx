import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBB } from 'three/examples/jsm/math/OBB.js'
import URDFLoader from 'urdf-loader'
import { useRobotStore } from '../../store/robotStore'
import { useSceneStore } from '../../store/sceneStore'
import { solveIK } from '../../engine/robot/ikSolver'
import { ShieldAlert, HelpCircle } from 'lucide-react'

import {
  getRobotRuntimeConfig,
  registerMoveLPlannerForRobot,
  registerMoveLRunner,
  registerMoveLRunnerForRobot
} from '../../services/robotMotionRuntime'
import { createViewportPerformanceMonitor } from '../../services/viewportPerformanceMonitor'
import type { MoveLRunOptions, PreparedMoveLTrajectory } from '../../services/robotMotionRuntime'
import { throwIfCommandCancelled } from '../../services/commandExecutionRuntime'
import { runScheduledJointTrajectory } from '../../services/factoryMotionScheduler'
import {
  clearRobotSafetyContact,
  getRobotSafetyContact,
  removeRobotSafetyState,
  reportRobotSafetyContact,
  throwIfRobotMotionBlocked
} from '../../services/robotFaultRuntime'
import { DEFAULT_JOINT_ANGLES } from '../../types/robot.types'
import type {
  JointAngles,
  RobotInstance,
  RobotSceneBinding,
  TCPPose,
  WorkflowStep
} from '../../types/robot.types'
import type { Transform3D } from '../../types/scene.types'

interface RobotJoint extends THREE.Object3D {
  setJointValue: (value: number) => void
}

interface FairinoRobotObject extends THREE.Object3D {
  joints: Record<string, RobotJoint>
  links: Record<string, THREE.Object3D>
}

interface ObbDistanceResult {
  distance: number
  pointA: THREE.Vector3
  pointB: THREE.Vector3
}

const ROBOT_MODEL_ALIGNMENT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-Math.PI / 2, 0, 0)
)

const ROBOT_MODEL_ALIGNMENT_INVERSE = ROBOT_MODEL_ALIGNMENT.clone().invert()
const ROBOT_WORLD_UP = new THREE.Vector3(0, 1, 0)
const COLLISION_CHECK_INTERVAL_MS = 50
const COLLISION_CONFIRMATION_SAMPLES = 3
const GROUND_PENETRATION_TOLERANCE_METERS = 0.002
const ROBOT_FAULT_COLOR = 0x7f1d1d
const ROBOT_FAULT_EMISSIVE = 0xff1f1f
const ROBOT_PROXIMITY_COLOR = 0x78350f
const ROBOT_PROXIMITY_EMISSIVE = 0xf59e0b

function toJointAngles(values: number[]): JointAngles {
  return values.slice(0, 6) as JointAngles
}

function isTcpPoseDifferent(a: TCPPose | undefined, b: TCPPose, tolerance = 0.5): boolean {
  if (!a) return true

  return (
    Math.abs(a.x - b.x) > tolerance ||
    Math.abs(a.y - b.y) > tolerance ||
    Math.abs(a.z - b.z) > tolerance ||
    Math.abs(a.rx - b.rx) > tolerance ||
    Math.abs(a.ry - b.ry) > tolerance ||
    Math.abs(a.rz - b.rz) > tolerance
  )
}

type HighlightableMaterial = THREE.Material & {
  emissive: THREE.Color
  emissiveIntensity: number
}

type ColorMaterial = THREE.Material & {
  color: THREE.Color
}

interface RobotMaterialSnapshot {
  material: HighlightableMaterial
  originalColor: THREE.Color | null
  originalEmissive: THREE.Color
  originalEmissiveIntensity: number
}

type RobotSafetyVisualState = 'normal' | 'proximity' | 'fault'

interface DetectedRobotCollision {
  kind: 'ground' | 'self' | 'obstacle'
  signature: string
  objectIds: string[]
  message: string
}

interface CollisionCandidate {
  signature: string
  consecutiveSamples: number
}

interface LinkLocalPoint {
  x: number
  y: number
  z: number
}

function isHighlightableMaterial(material: THREE.Material): material is HighlightableMaterial {
  return (
    'emissive' in material &&
    material.emissive instanceof THREE.Color &&
    'emissiveIntensity' in material
  )
}

function isColorMaterial(material: THREE.Material): material is ColorMaterial {
  return 'color' in material && material.color instanceof THREE.Color
}

function waitForMoveLFrame(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfCommandCancelled(signal)

  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      window.clearTimeout(timeoutId)
      signal.removeEventListener('abort', handleAbort)

      try {
        throwIfCommandCancelled(signal)
      } catch (error) {
        reject(error)
      }
    }

    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, milliseconds)

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

function createSceneBindingFromRobotObject(
  robot: FairinoRobotObject,
  currentSceneBinding?: RobotSceneBinding | null
): RobotSceneBinding {
  const yawOnlyQuaternion = robot.quaternion
    .clone()
    .multiply(ROBOT_MODEL_ALIGNMENT_INVERSE)
    .normalize()

  const yawEuler = new THREE.Euler().setFromQuaternion(yawOnlyQuaternion, 'YXZ')
  const baseYaw = Math.round(THREE.MathUtils.radToDeg(yawEuler.y) * 10) / 10

  return {
    id: currentSceneBinding?.id,
    sceneType: currentSceneBinding?.sceneType || 'FairinoStudio',
    baseX: Math.round(robot.position.x * 1000),
    baseY: Math.round(robot.position.z * 1000),
    baseZ: Math.round(robot.position.y * 1000),
    baseYaw,
    urdfPath: currentSceneBinding?.urdfPath ?? null,
    primPath: currentSceneBinding?.primPath ?? null,
    rosNamespace: currentSceneBinding?.rosNamespace ?? null,
    graphPath: currentSceneBinding?.graphPath ?? null
  }
}

function applyRobotSceneBinding(
  robot: FairinoRobotObject,
  sceneBinding?: RobotSceneBinding | null
): void {
  const millimetersToMeters = 0.001

  const baseX = (sceneBinding?.baseX ?? 0) * millimetersToMeters
  const baseY = (sceneBinding?.baseY ?? 0) * millimetersToMeters
  const baseZ = (sceneBinding?.baseZ ?? 0) * millimetersToMeters
  const baseYaw = sceneBinding?.baseYaw ?? 0

  const yawRotation = new THREE.Quaternion().setFromAxisAngle(
    ROBOT_WORLD_UP,
    THREE.MathUtils.degToRad(baseYaw)
  )

  robot.position.set(baseX, baseZ, baseY)
  robot.quaternion.copy(yawRotation).multiply(ROBOT_MODEL_ALIGNMENT)
  robot.updateMatrixWorld(true)
}

const SELF_COLLISION_PAIRS = [
  { a: 'shoulder_link', b: 'forearm_link' },
  { a: 'shoulder_link', b: 'wrist1_link' },
  { a: 'shoulder_link', b: 'wrist2_link' },
  { a: 'shoulder_link', b: 'wrist3_link' },
  { a: 'upperarm_link', b: 'wrist1_link' },
  { a: 'upperarm_link', b: 'wrist2_link' },
  { a: 'upperarm_link', b: 'wrist3_link' },
  { a: 'forearm_link', b: 'wrist3_link' }
]

export default function Viewport3D(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const robotRef = useRef<FairinoRobotObject | null>(null)
  const robotRefs = useRef<Map<string, FairinoRobotObject>>(new Map())
  const robotMaterialSnapshotsByRobotIdRef = useRef<Map<string, RobotMaterialSnapshot[]>>(new Map())
  const robotSafetyVisualStateByRobotIdRef = useRef<Map<string, RobotSafetyVisualState>>(new Map())
  const lastCollisionCheckAtMsRef = useRef(0)
  const collisionCandidateByRobotIdRef = useRef<Map<string, CollisionCandidate>>(new Map())
  const groundVerticesByLinkNameRef = useRef<Map<string, readonly LinkLocalPoint[]>>(new Map())
  const moveLRunnerUnregisterByRobotIdRef = useRef<Map<string, () => void>>(new Map())
  const previewRobotRef = useRef<FairinoRobotObject | null>(null)
  const previewRobotLoadingRef = useRef(false)
  const previewRobotLoadGenerationRef = useRef(0)
  const loadingRobotIdsRef = useRef<Set<string>>(new Set())
  const robotsRef = useRef<RobotInstance[]>([])
  const sceneRef = useRef<THREE.Scene | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const transformControlsRef = useRef<TransformControls | null>(null)
  const dummyTargetRef = useRef<THREE.Object3D | null>(null)
  const boxHelperRef = useRef<THREE.BoxHelper | null>(null)
  const measureLineRef = useRef<THREE.Line | null>(null)
  const selfMeasureLineRef = useRef<THREE.Line | null>(null)
  const hitboxHelpersRef = useRef<THREE.LineSegments[]>([])
  const keysPressedRef = useRef<Set<string>>(new Set())
  const [isRobotLoaded, setIsRobotLoaded] = useState(false)

  // Helper to dispose robot 3D geometries and materials
  function disposeRobotObject(robotObj: THREE.Object3D): void {
    robotObj.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        if (child.geometry) child.geometry.dispose()
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((mat) => mat.dispose())
          } else {
            child.material.dispose()
          }
        }
      }
    })
  }

  function cacheRobotMaterials(robotId: string, robotObj: THREE.Object3D): void {
    const snapshots: RobotMaterialSnapshot[] = []
    const clonedMaterialsBySource = new Map<THREE.Material, THREE.Material>()
    const snapshottedMaterials = new Set<THREE.Material>()

    robotObj.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return

      const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material]
      const clonedMaterials = sourceMaterials.map((sourceMaterial) => {
        const cachedMaterial = clonedMaterialsBySource.get(sourceMaterial)
        if (cachedMaterial) return cachedMaterial

        const clonedMaterial = sourceMaterial.clone()
        clonedMaterialsBySource.set(sourceMaterial, clonedMaterial)
        return clonedMaterial
      })

      child.material = Array.isArray(child.material) ? clonedMaterials : clonedMaterials[0]

      for (const material of clonedMaterials) {
        if (!isHighlightableMaterial(material) || snapshottedMaterials.has(material)) continue
        snapshottedMaterials.add(material)

        snapshots.push({
          material,
          originalColor: isColorMaterial(material) ? material.color.clone() : null,
          originalEmissive: material.emissive.clone(),
          originalEmissiveIntensity: material.emissiveIntensity
        })
      }
    })

    for (const sourceMaterial of clonedMaterialsBySource.keys()) {
      sourceMaterial.dispose()
    }

    robotMaterialSnapshotsByRobotIdRef.current.set(robotId, snapshots)
    robotSafetyVisualStateByRobotIdRef.current.delete(robotId)
  }

  function removeRobotMaterialCache(robotId: string): void {
    robotMaterialSnapshotsByRobotIdRef.current.delete(robotId)
    robotSafetyVisualStateByRobotIdRef.current.delete(robotId)
  }

  function getRobotSafetyVisualState(robotId: string): RobotSafetyVisualState {
    const sceneState = useSceneStore.getState()
    if (sceneState.robotFaultsById[robotId]?.active) return 'fault'
    if (sceneState.robotContactsById[robotId]?.level === 'proximity') return 'proximity'

    return 'normal'
  }

  function applyRobotSafetyVisual(robotId: string, force = false): void {
    const snapshots = robotMaterialSnapshotsByRobotIdRef.current.get(robotId)
    if (!snapshots) return

    const nextState = getRobotSafetyVisualState(robotId)
    if (!force && robotSafetyVisualStateByRobotIdRef.current.get(robotId) === nextState) return

    for (const snapshot of snapshots) {
      if (snapshot.originalColor && isColorMaterial(snapshot.material)) {
        snapshot.material.color.copy(snapshot.originalColor)
      }

      snapshot.material.emissive.copy(snapshot.originalEmissive)
      snapshot.material.emissiveIntensity = snapshot.originalEmissiveIntensity

      if (nextState === 'fault') {
        if (isColorMaterial(snapshot.material)) {
          snapshot.material.color.setHex(ROBOT_FAULT_COLOR)
        }
        snapshot.material.emissive.setHex(ROBOT_FAULT_EMISSIVE)
        snapshot.material.emissiveIntensity = 1.35
      } else if (nextState === 'proximity') {
        if (isColorMaterial(snapshot.material)) {
          snapshot.material.color.setHex(ROBOT_PROXIMITY_COLOR)
        }
        snapshot.material.emissive.setHex(ROBOT_PROXIMITY_EMISSIVE)
        snapshot.material.emissiveIntensity = 0.85
      }

      snapshot.material.needsUpdate = true
    }

    robotSafetyVisualStateByRobotIdRef.current.set(robotId, nextState)
  }

  // Track loaded 3D models: map objectId -> THREE.Object3D
  const loadedObjectsRef = useRef<Map<string, THREE.Object3D>>(new Map())

  // Cache the last user config JSON to block infinite store update loop
  const lastUserConfigRef = useRef<string>('')

  const jointAngles = useRobotStore((state) => state.jointAngles)
  const jointAnglesByRobotId = useRobotStore((state) => state.jointAnglesByRobotId)
  const setJointAngles = useRobotStore((state) => state.setJointAngles)
  const setJointAnglesForRobot = useRobotStore((state) => state.setJointAnglesForRobot)
  const setTCPPose = useRobotStore((state) => state.setTCPPose)
  const setTCPPoseForRobot = useRobotStore((state) => state.setTCPPoseForRobot)
  const isIKMode = useRobotStore((state) => state.isIKMode)
  const isRobotPlacementMode = useRobotStore((state) => state.isRobotPlacementMode)
  const robotPlacementTransformMode = useRobotStore((state) => state.robotPlacementTransformMode)
  const isPlaying = useRobotStore((state) => {
    const robotId = state.selectedRobotId

    return robotId ? (state.robotExecutionById[robotId]?.isPlaying ?? false) : state.isPlaying
  })
  const selectedJointName = useRobotStore((state) => state.selectedJointName)
  const steps = useRobotStore((state) => state.steps)
  const robots = useRobotStore((state) => state.robots)
  const selectedRobotId = useRobotStore((state) => state.selectedRobotId)
  const workspaceMode = useRobotStore((state) => state.workspaceMode)
  const selectedRobot = robots.find((robot) => robot.id === selectedRobotId) ?? null
  const selectedRobotSceneBinding = selectedRobot?.sceneBinding ?? null

  const objects = useSceneStore((state) => state.objects)
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId)
  const collisionWarning = useSceneStore((state) => state.collisionWarning)
  const robotFaultsById = useSceneStore((state) => state.robotFaultsById)
  const robotContactsById = useSceneStore((state) => state.robotContactsById)

  // Sync robots to ref for async loader check
  useEffect(() => {
    robotsRef.current = robots
  }, [robots])

  useEffect(() => {
    const robot = robotRef.current

    if (!robot || !isRobotLoaded) {
      return
    }

    applyRobotSceneBinding(robot, selectedRobotSceneBinding)
  }, [
    isRobotLoaded,
    selectedRobotId,
    selectedRobotSceneBinding,
    selectedRobotSceneBinding?.baseX,
    selectedRobotSceneBinding?.baseY,
    selectedRobotSceneBinding?.baseZ,
    selectedRobotSceneBinding?.baseYaw
  ])

  useEffect(() => {
    for (const robotId of robotRefs.current.keys()) {
      applyRobotSafetyVisual(robotId)
    }

    if (selectedRobotId && getRobotSafetyVisualState(selectedRobotId) === 'normal') {
      highlightJointLink(selectedJointName)
    }
    // Material caches are stable refs; updates are driven only by safety-state transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robotContactsById, robotFaultsById, selectedJointName, selectedRobotId])

  // Helper to compute Forward Kinematics (FK)
  const computeFK = (angles: number[], robot: FairinoRobotObject): TCPPose => {
    const jointNames = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6']
    const originalAngles = jointNames.map((name) => robot.joints[name].rotation.z)

    jointNames.forEach((name, idx) => {
      robot.joints[name].setJointValue((angles[idx] * Math.PI) / 180)
    })
    robot.updateMatrixWorld(true)

    const baseLink = robot.links['base_link']
    const wristLink = robot.links['wrist3_link']
    const pos = new THREE.Vector3()
    const q = new THREE.Quaternion()

    if (baseLink && wristLink) {
      const baseMatInv = new THREE.Matrix4().copy(baseLink.matrixWorld).invert()
      const relativeMat = new THREE.Matrix4().multiplyMatrices(baseMatInv, wristLink.matrixWorld)
      relativeMat.decompose(pos, q, new THREE.Vector3())
    }

    jointNames.forEach((name, idx) => {
      robot.joints[name].setJointValue(originalAngles[idx])
    })
    robot.updateMatrixWorld(true)

    const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ')
    return {
      x: Math.round(pos.x * 1000 * 10) / 10,
      y: Math.round(pos.y * 1000 * 10) / 10,
      z: Math.round(pos.z * 1000 * 10) / 10,
      rx: Math.round(((euler.x * 180) / Math.PI) * 10) / 10,
      ry: Math.round(((euler.y * 180) / Math.PI) * 10) / 10,
      rz: Math.round(((euler.z * 180) / Math.PI) * 10) / 10
    }
  }

  // Helper to compute Inverse Kinematics (IK)
  const computeIK = (
    tcp: TCPPose,
    currentAngles: number[],
    robot: FairinoRobotObject
  ): JointAngles | null => {
    const targetPos = new THREE.Vector3(tcp.x / 1000, tcp.y / 1000, tcp.z / 1000)
    const euler = new THREE.Euler(
      (tcp.rx * Math.PI) / 180,
      (tcp.ry * Math.PI) / 180,
      (tcp.rz * Math.PI) / 180,
      'XYZ'
    )
    const targetQuat = new THREE.Quaternion().setFromEuler(euler)
    return solveIK(targetPos, targetQuat, currentAngles as JointAngles, robot)
  }

  const angularDifference = (first: number, second: number): number => {
    const difference = ((((first - second + 180) % 360) + 360) % 360) - 180
    return Math.abs(difference)
  }

  function createMoveLRunnerForRobot(robotId: string, robot: FairinoRobotObject) {
    return async (
      targetPose: TCPPose,
      speed: number,
      signal: AbortSignal,
      options?: MoveLRunOptions
    ): Promise<void> => {
      throwIfCommandCancelled(signal)
      throwIfRobotMotionBlocked(robotId)

      const managePlayingState = options?.managePlayingState !== false
      const preparedTrajectory = options?.preparedTrajectory

      if (preparedTrajectory) {
        if (
          preparedTrajectory.keyframes.length < 2 ||
          preparedTrajectory.waypointCount !== preparedTrajectory.keyframes.length - 1
        ) {
          throw new Error(`Prepared MoveL trajectory is invalid for robot ${robotId}`)
        }

        const currentAngles =
          useRobotStore.getState().jointAnglesByRobotId[robotId] ??
          ([...DEFAULT_JOINT_ANGLES] as JointAngles)

        const preparedStartAngles = preparedTrajectory.keyframes[0]

        const largestStartDifference = Math.max(
          ...preparedStartAngles.map((angle, index) => Math.abs(angle - currentAngles[index]))
        )

        if (largestStartDifference > 0.5) {
          throw new Error(
            `Prepared MoveL start state differs from robot ${robotId} by ` +
              `${largestStartDifference.toFixed(2)} degrees`
          )
        }

        const durationMs =
          typeof options?.durationMs === 'number' &&
          Number.isFinite(options.durationMs) &&
          options.durationMs > 0
            ? options.durationMs
            : Math.max(
                16,
                preparedTrajectory.waypointCount *
                  Math.max(16, 110 - Math.max(1, Math.min(100, speed)))
              )

        if (managePlayingState) {
          useRobotStore.getState().setPlaying(true)
        }

        try {
          await runScheduledJointTrajectory(
            robotId,
            preparedTrajectory.keyframes,
            durationMs,
            signal,
            options?.startedAtMonotonicMs
          )
        } finally {
          if (managePlayingState) {
            useRobotStore.getState().setPlaying(false)
          }
        }

        throwIfCommandCancelled(signal)
        throwIfRobotMotionBlocked(robotId)
        return
      }

      // Fallback for Train mode and MoveL commands without a prepared trajectory.
      const robotStore = useRobotStore.getState()
      const startAngles = robotStore.jointAnglesByRobotId[robotId] ?? [...DEFAULT_JOINT_ANGLES]
      const startPose = computeFK(startAngles, robot)

      const startPosition = new THREE.Vector3(
        startPose.x / 1000,
        startPose.y / 1000,
        startPose.z / 1000
      )

      const targetPosition = new THREE.Vector3(
        targetPose.x / 1000,
        targetPose.y / 1000,
        targetPose.z / 1000
      )

      const startQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(startPose.rx),
          THREE.MathUtils.degToRad(startPose.ry),
          THREE.MathUtils.degToRad(startPose.rz),
          'XYZ'
        )
      )

      const targetQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(targetPose.rx),
          THREE.MathUtils.degToRad(targetPose.ry),
          THREE.MathUtils.degToRad(targetPose.rz),
          'XYZ'
        )
      )

      const distanceMillimeters = startPosition.distanceTo(targetPosition) * 1000
      const rotationDegrees = THREE.MathUtils.radToDeg(startQuaternion.angleTo(targetQuaternion))

      const moveLPolicy = getRobotRuntimeConfig(robotId).motionPolicy.moveL
      const waypointCount = Math.max(
        1,
        Math.ceil(distanceMillimeters / Math.max(1, moveLPolicy.waypointSpacingMm)),
        Math.ceil(rotationDegrees)
      )
      const frameDelayMs = options?.durationMs
        ? Math.max(16, options.durationMs / waypointCount)
        : Math.max(16, 110 - speed)
      const moveLStartedAt = performance.now()

      if (managePlayingState) {
        useRobotStore.getState().setPlaying(true)
      }

      try {
        for (let waypointIndex = 1; waypointIndex <= waypointCount; waypointIndex++) {
          throwIfCommandCancelled(signal)
          throwIfRobotMotionBlocked(robotId)

          if (performance.now() - moveLStartedAt > moveLPolicy.timeoutMs) {
            throw new Error(`MoveL exceeded simulator timeout`)
          }

          const progress = waypointIndex / waypointCount
          const waypointPosition = startPosition.clone().lerp(targetPosition, progress)
          const waypointQuaternion = startQuaternion.clone().slerp(targetQuaternion, progress)

          const currentAngles = useRobotStore.getState().jointAnglesByRobotId[robotId] ?? [
            ...DEFAULT_JOINT_ANGLES
          ]

          const nextAngles = solveIK(waypointPosition, waypointQuaternion, currentAngles, robot)

          if (!nextAngles) {
            throw new Error(`MoveL IK failed at waypoint ${waypointIndex}/${waypointCount}`)
          }

          setJointAnglesForRobot(robotId, nextAngles as JointAngles)

          await waitForMoveLFrame(frameDelayMs, signal)
        }
      } finally {
        if (managePlayingState) {
          useRobotStore.getState().setPlaying(false)
        }
      }
    }
  }
  function createMoveLPlannerForRobot(robotId: string, robot: FairinoRobotObject) {
    return async (
      targetPose: TCPPose,
      _speed: number,
      startAngles: JointAngles,
      signal: AbortSignal
    ): Promise<PreparedMoveLTrajectory> => {
      throwIfCommandCancelled(signal)
      throwIfRobotMotionBlocked(robotId)

      const planningStartedAt = performance.now()
      const startPose = computeFK(startAngles, robot)

      const startPosition = new THREE.Vector3(
        startPose.x / 1000,
        startPose.y / 1000,
        startPose.z / 1000
      )

      const targetPosition = new THREE.Vector3(
        targetPose.x / 1000,
        targetPose.y / 1000,
        targetPose.z / 1000
      )

      const startQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(startPose.rx),
          THREE.MathUtils.degToRad(startPose.ry),
          THREE.MathUtils.degToRad(startPose.rz),
          'XYZ'
        )
      )

      const targetQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(targetPose.rx),
          THREE.MathUtils.degToRad(targetPose.ry),
          THREE.MathUtils.degToRad(targetPose.rz),
          'XYZ'
        )
      )

      const distanceMillimeters = startPosition.distanceTo(targetPosition) * 1000
      const rotationDegrees = THREE.MathUtils.radToDeg(startQuaternion.angleTo(targetQuaternion))

      const moveLPolicy = getRobotRuntimeConfig(robotId).motionPolicy.moveL
      const waypointSpacingMillimeters = Math.max(1, moveLPolicy.waypointSpacingMm)

      if (distanceMillimeters > moveLPolicy.maxDistanceMm) {
        throw new Error(
          `MoveL distance ${distanceMillimeters.toFixed(1)} mm exceeds simulator limit ` +
            `${moveLPolicy.maxDistanceMm} mm for robot ${robotId}`
        )
      }

      if (rotationDegrees > moveLPolicy.maxRotationDeg) {
        throw new Error(
          `MoveL rotation ${rotationDegrees.toFixed(1)} degrees exceeds simulator limit ` +
            `${moveLPolicy.maxRotationDeg} degrees for robot ${robotId}`
        )
      }

      const cartesianWaypointCount = Math.max(
        1,
        Math.ceil(distanceMillimeters / waypointSpacingMillimeters),
        Math.ceil(rotationDegrees)
      )

      const keyframes: JointAngles[] = [[...startAngles] as JointAngles]
      let planningAngles = [...startAngles] as JointAngles

      for (let waypointIndex = 1; waypointIndex <= cartesianWaypointCount; waypointIndex++) {
        throwIfCommandCancelled(signal)
        throwIfRobotMotionBlocked(robotId)

        if (performance.now() - planningStartedAt > moveLPolicy.timeoutMs) {
          throw new Error(
            `MoveL planning exceeded ${moveLPolicy.timeoutMs} ms for robot ${robotId}`
          )
        }

        const progress = waypointIndex / cartesianWaypointCount
        const waypointPosition = startPosition.clone().lerp(targetPosition, progress)
        const waypointQuaternion = startQuaternion.clone().slerp(targetQuaternion, progress)

        const waypointEuler = new THREE.Euler().setFromQuaternion(waypointQuaternion, 'XYZ')

        const waypointPose: TCPPose = {
          x: waypointPosition.x * 1000,
          y: waypointPosition.y * 1000,
          z: waypointPosition.z * 1000,
          rx: THREE.MathUtils.radToDeg(waypointEuler.x),
          ry: THREE.MathUtils.radToDeg(waypointEuler.y),
          rz: THREE.MathUtils.radToDeg(waypointEuler.z)
        }

        let waypointReached = false

        for (let attempt = 0; attempt < 25; attempt++) {
          throwIfCommandCancelled(signal)
          throwIfRobotMotionBlocked(robotId)

          if (performance.now() - planningStartedAt > moveLPolicy.timeoutMs) {
            throw new Error(
              `MoveL planning exceeded ${moveLPolicy.timeoutMs} ms for robot ${robotId}`
            )
          }

          const nextAngles = solveIK(waypointPosition, waypointQuaternion, planningAngles, robot)

          if (!nextAngles) {
            throw new Error(
              `MoveL IK planning failed at waypoint ` +
                `${waypointIndex}/${cartesianWaypointCount} for robot ${robotId}`
            )
          }

          const preparedAngles = [...nextAngles] as JointAngles
          const largestJointChange = Math.max(
            ...preparedAngles.map((angle, index) => Math.abs(angle - planningAngles[index]))
          )

          planningAngles = preparedAngles
          keyframes.push([...preparedAngles] as JointAngles)

          const actualPose = computeFK(preparedAngles, robot)

          const positionError = Math.hypot(
            actualPose.x - waypointPose.x,
            actualPose.y - waypointPose.y,
            actualPose.z - waypointPose.z
          )

          const rotationError = Math.max(
            angularDifference(actualPose.rx, waypointPose.rx),
            angularDifference(actualPose.ry, waypointPose.ry),
            angularDifference(actualPose.rz, waypointPose.rz)
          )

          if (positionError <= 0.75 && rotationError <= 0.5) {
            waypointReached = true
            break
          }

          if (largestJointChange < 0.005) {
            break
          }
        }

        if (!waypointReached) {
          throw new Error(
            `MoveL planning could not reach Cartesian waypoint ` +
              `${waypointIndex}/${cartesianWaypointCount} for robot ${robotId}`
          )
        }

        // Nhường main thread định kỳ trong giai đoạn chuẩn bị.
        // Việc này xảy ra trước synchronized start nên không tạo timing skew.
        if (waypointIndex % 4 === 0) {
          await waitForMoveLFrame(0, signal)
        }
      }

      throwIfCommandCancelled(signal)
      throwIfRobotMotionBlocked(robotId)

      return {
        keyframes,
        waypointCount: keyframes.length - 1,
        planningDurationMs: performance.now() - planningStartedAt
      }
    }
  }

  function registerLoadedRobotMoveLRunner(robotId: string, robot: FairinoRobotObject): void {
    moveLRunnerUnregisterByRobotIdRef.current.get(robotId)?.()

    const unregisterRunner = registerMoveLRunnerForRobot(
      robotId,
      createMoveLRunnerForRobot(robotId, robot)
    )

    const unregisterPlanner = registerMoveLPlannerForRobot(
      robotId,
      createMoveLPlannerForRobot(robotId, robot)
    )

    const unregisterRuntime = (): void => {
      unregisterPlanner()
      unregisterRunner()
    }

    moveLRunnerUnregisterByRobotIdRef.current.set(robotId, unregisterRuntime)
  }
  function unregisterLoadedRobotMoveLRunner(robotId: string): void {
    moveLRunnerUnregisterByRobotIdRef.current.get(robotId)?.()
    moveLRunnerUnregisterByRobotIdRef.current.delete(robotId)
  }

  useEffect(() => {
    const unregisterMap = moveLRunnerUnregisterByRobotIdRef.current

    return () => {
      for (const unregister of unregisterMap.values()) {
        unregister()
      }

      unregisterMap.clear()
    }
  }, [])

  useEffect(() => {
    return registerMoveLRunner(async (targetPose, speed, signal, options): Promise<void> => {
      throwIfCommandCancelled(signal)
      const managePlayingState = options?.managePlayingState !== false

      const robot = robotRef.current

      if (!robot) {
        throw new Error('Robot model has not finished loading')
      }

      const startAngles = useRobotStore.getState().jointAngles
      const startPose = computeFK(startAngles, robot)

      const startPosition = new THREE.Vector3(
        startPose.x / 1000,
        startPose.y / 1000,
        startPose.z / 1000
      )

      const targetPosition = new THREE.Vector3(
        targetPose.x / 1000,
        targetPose.y / 1000,
        targetPose.z / 1000
      )

      const startQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(startPose.rx),
          THREE.MathUtils.degToRad(startPose.ry),
          THREE.MathUtils.degToRad(startPose.rz),
          'XYZ'
        )
      )

      const targetQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(targetPose.rx),
          THREE.MathUtils.degToRad(targetPose.ry),
          THREE.MathUtils.degToRad(targetPose.rz),
          'XYZ'
        )
      )

      const distanceMillimeters = startPosition.distanceTo(targetPosition) * 1000

      const rotationDegrees = THREE.MathUtils.radToDeg(startQuaternion.angleTo(targetQuaternion))

      const moveLPolicy = getRobotRuntimeConfig().motionPolicy.moveL
      const maxMoveLDistanceMillimeters = moveLPolicy.maxDistanceMm
      const maxMoveLRotationDegrees = moveLPolicy.maxRotationDeg
      const maxMoveLDurationMilliseconds = moveLPolicy.timeoutMs
      const waypointSpacingMillimeters = Math.max(1, moveLPolicy.waypointSpacingMm)
      const moveLStartedAt = performance.now()

      if (distanceMillimeters > maxMoveLDistanceMillimeters) {
        throw new Error(
          `MoveL distance ${distanceMillimeters.toFixed(1)} mm exceeds simulator limit ` +
            `${maxMoveLDistanceMillimeters} mm`
        )
      }

      if (rotationDegrees > maxMoveLRotationDegrees) {
        throw new Error(
          `MoveL rotation ${rotationDegrees.toFixed(1)} degrees exceeds simulator limit ` +
            `${maxMoveLRotationDegrees} degrees`
        )
      }

      const waypointCount = Math.max(
        1,
        Math.ceil(distanceMillimeters / waypointSpacingMillimeters),
        Math.ceil(rotationDegrees)
      )

      const frameDelayMs = options?.durationMs
        ? Math.max(16, options.durationMs / waypointCount)
        : Math.max(16, 110 - speed)

      if (managePlayingState) {
        useRobotStore.getState().setPlaying(true)
      }

      try {
        for (let waypointIndex = 1; waypointIndex <= waypointCount; waypointIndex++) {
          throwIfCommandCancelled(signal)

          if (performance.now() - moveLStartedAt > maxMoveLDurationMilliseconds) {
            throw new Error(
              `MoveL exceeded the ${Math.round(maxMoveLDurationMilliseconds / 1000)} second simulator execution limit`
            )
          }

          const progress = waypointIndex / waypointCount

          const waypointPosition = startPosition.clone().lerp(targetPosition, progress)

          const waypointQuaternion = startQuaternion.clone().slerp(targetQuaternion, progress)

          const waypointEuler = new THREE.Euler().setFromQuaternion(waypointQuaternion, 'XYZ')

          const waypointPose = {
            x: waypointPosition.x * 1000,
            y: waypointPosition.y * 1000,
            z: waypointPosition.z * 1000,
            rx: THREE.MathUtils.radToDeg(waypointEuler.x),
            ry: THREE.MathUtils.radToDeg(waypointEuler.y),
            rz: THREE.MathUtils.radToDeg(waypointEuler.z)
          }

          let waypointReached = false

          for (let attempt = 0; attempt < 25; attempt++) {
            throwIfCommandCancelled(signal)

            const currentAngles = useRobotStore.getState().jointAngles

            const nextAngles = solveIK(waypointPosition, waypointQuaternion, currentAngles, robot)

            if (!nextAngles) {
              throw new Error(`MoveL IK failed at waypoint ${waypointIndex}/${waypointCount}`)
            }

            const largestJointChange = Math.max(
              ...nextAngles.map((angle, index) => Math.abs(angle - currentAngles[index]))
            )

            useRobotStore.getState().setJointAngles(nextAngles as JointAngles)

            await waitForMoveLFrame(frameDelayMs, signal)
            throwIfCommandCancelled(signal)

            const actualPose = computeFK(nextAngles, robot)

            const positionError = Math.hypot(
              actualPose.x - waypointPose.x,
              actualPose.y - waypointPose.y,
              actualPose.z - waypointPose.z
            )

            const rotationError = Math.max(
              angularDifference(actualPose.rx, waypointPose.rx),
              angularDifference(actualPose.ry, waypointPose.ry),
              angularDifference(actualPose.rz, waypointPose.rz)
            )

            if (positionError <= 0.75 && rotationError <= 0.5) {
              waypointReached = true
              break
            }

            if (largestJointChange < 0.005) {
              break
            }
          }

          if (!waypointReached) {
            throw new Error(
              `MoveL could not reach Cartesian waypoint ${waypointIndex}/${waypointCount}`
            )
          }
        }

        throwIfCommandCancelled(signal)

        const finalPose = computeFK(useRobotStore.getState().jointAngles, robot)

        const finalPositionError = Math.hypot(
          finalPose.x - targetPose.x,
          finalPose.y - targetPose.y,
          finalPose.z - targetPose.z
        )

        const finalRotationError = Math.max(
          angularDifference(finalPose.rx, targetPose.rx),
          angularDifference(finalPose.ry, targetPose.ry),
          angularDifference(finalPose.rz, targetPose.rz)
        )

        if (finalPositionError > 1 || finalRotationError > 1) {
          throw new Error(
            `MoveL final pose error: ${finalPositionError.toFixed(2)} mm, ` +
              `${finalRotationError.toFixed(2)} deg`
          )
        }
      } finally {
        if (managePlayingState) {
          useRobotStore.getState().setPlaying(false)
        }
      }
    })
  }, [isRobotLoaded])

  // Compute a tight OBB for a single URDF link.
  // IMPORTANT: In URDFLoader's scene graph, shoulder_link CONTAINS upperarm_link as a descendant.
  // Using traverse() would collect ALL child arm meshes, making the OBB huge.
  // This custom traversal stops at link boundaries (allLinkObjs set) so each OBB
  // only covers the geometry that PHYSICALLY BELONGS to that specific link.
  const computeLinkOBB = (
    linkObj: THREE.Object3D,
    allLinkObjs: Set<THREE.Object3D>
  ): OBB | null => {
    const invMatrix = new THREE.Matrix4().copy(linkObj.matrixWorld).invert()
    const localBox = new THREE.Box3()
    let hasMesh = false

    // Custom DFS that stops when it enters a different link's subtree
    const collectMeshes = (node: THREE.Object3D): void => {
      // Stop traversal if we've entered a child link (but allow the root linkObj itself)
      if (node !== linkObj && allLinkObjs.has(node)) return

      if (node instanceof THREE.Mesh && node.geometry) {
        const mesh = node
        mesh.geometry.computeBoundingBox()
        if (mesh.geometry.boundingBox) {
          // Transform mesh-local bounds into the link's local coordinate frame
          const childRelMat = new THREE.Matrix4().multiplyMatrices(invMatrix, mesh.matrixWorld)
          const meshLocalBox = mesh.geometry.boundingBox.clone().applyMatrix4(childRelMat)
          localBox.union(meshLocalBox)
          hasMesh = true
        }
      }

      for (const child of node.children) {
        collectMeshes(child)
      }
    }

    collectMeshes(linkObj)

    if (!hasMesh || localBox.isEmpty()) return null

    // Center: local centroid projected into world space
    const localCenter = new THREE.Vector3()
    localBox.getCenter(localCenter)
    const worldCenter = localCenter.clone().applyMatrix4(linkObj.matrixWorld)

    // HalfSize from the link-local bounding box
    const halfSize = new THREE.Vector3()
    localBox.getSize(halfSize).multiplyScalar(0.5)

    // Rotation: extract and normalize rotation columns from world matrix (strip scale)
    const rotMat = new THREE.Matrix3().setFromMatrix4(linkObj.matrixWorld)
    const el = rotMat.elements
    const scaleX = new THREE.Vector3(el[0], el[1], el[2]).length()
    const scaleY = new THREE.Vector3(el[3], el[4], el[5]).length()
    const scaleZ = new THREE.Vector3(el[6], el[7], el[8]).length()
    rotMat.elements[0] /= scaleX
    rotMat.elements[1] /= scaleX
    rotMat.elements[2] /= scaleX
    rotMat.elements[3] /= scaleY
    rotMat.elements[4] /= scaleY
    rotMat.elements[5] /= scaleY
    rotMat.elements[6] /= scaleZ
    rotMat.elements[7] /= scaleZ
    rotMat.elements[8] /= scaleZ

    return new OBB(worldCenter, halfSize, rotMat)
  }

  // OBB is intentionally used only as a cheap broad phase. For the ground plane,
  // a rotated OBB can extend below the real mesh and produce a false collision.
  // Cache the real link vertices in link-local coordinates and evaluate them only
  // when the OBB reports a possible penetration.
  const getLinkLocalGroundVertices = (
    linkName: string,
    linkObj: THREE.Object3D,
    allLinkObjs: Set<THREE.Object3D>
  ): readonly LinkLocalPoint[] => {
    const cacheKey = linkName.toLowerCase()
    const cached = groundVerticesByLinkNameRef.current.get(cacheKey)
    if (cached) return cached

    const invLinkMatrix = new THREE.Matrix4().copy(linkObj.matrixWorld).invert()
    const localPoint = new THREE.Vector3()
    const uniquePoints = new Map<string, LinkLocalPoint>()

    const collectVertices = (node: THREE.Object3D): void => {
      if (node !== linkObj && allLinkObjs.has(node)) return

      if (node instanceof THREE.Mesh && node.geometry) {
        const position = node.geometry.getAttribute('position')

        if (position) {
          const meshToLink = new THREE.Matrix4().multiplyMatrices(invLinkMatrix, node.matrixWorld)

          for (let index = 0; index < position.count; index++) {
            localPoint
              .set(position.getX(index), position.getY(index), position.getZ(index))
              .applyMatrix4(meshToLink)

            // STL repeats vertices for every triangle. Quantizing to one micrometre
            // removes duplicates and keeps the narrow phase inexpensive.
            const key =
              `${Math.round(localPoint.x * 1_000_000)}:` +
              `${Math.round(localPoint.y * 1_000_000)}:` +
              `${Math.round(localPoint.z * 1_000_000)}`

            if (!uniquePoints.has(key)) {
              uniquePoints.set(key, {
                x: localPoint.x,
                y: localPoint.y,
                z: localPoint.z
              })
            }
          }
        }
      }

      for (const child of node.children) {
        collectVertices(child)
      }
    }

    collectVertices(linkObj)

    const vertices = [...uniquePoints.values()]
    groundVerticesByLinkNameRef.current.set(cacheKey, vertices)
    return vertices
  }

  const getExactLinkMinimumWorldY = (
    linkName: string,
    linkObj: THREE.Object3D,
    allLinkObjs: Set<THREE.Object3D>
  ): number => {
    const vertices = getLinkLocalGroundVertices(linkName, linkObj, allLinkObjs)
    if (vertices.length === 0) return Infinity

    const elements = linkObj.matrixWorld.elements
    let minimumY = Infinity

    // Matrix4 is column-major. Computing only the Y component avoids allocating
    // thousands of Vector3 objects during the collision loop.
    for (const point of vertices) {
      const worldY =
        elements[1] * point.x + elements[5] * point.y + elements[9] * point.z + elements[13]
      minimumY = Math.min(minimumY, worldY)
    }

    return minimumY
  }

  // Calculate approximate closest points between two OBBs using iterative clamp
  const getOBBDistance = (obbA: OBB, obbB: OBB): ObbDistanceResult => {
    const pointB = new THREE.Vector3()
    obbB.clampPoint(obbA.center, pointB)
    const pointA = new THREE.Vector3()
    obbA.clampPoint(pointB, pointA)
    return { distance: pointA.distanceTo(pointB), pointA, pointB }
  }

  // Draw 12 edges of an OBB as a LineSegments object (oriented wireframe)
  const createOBBWireframe = (obb: OBB, color: number): THREE.LineSegments => {
    const { center, halfSize, rotation } = obb
    const corners: THREE.Vector3[] = []
    // 8 corners: all sign combinations of halfSize, rotated and translated
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const c = new THREE.Vector3(sx * halfSize.x, sy * halfSize.y, sz * halfSize.z)
            .applyMatrix3(rotation)
            .add(center)
          corners.push(c)
        }
    // Canonical edge list for a box (12 edges)
    const edgePairs = [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [0, 2],
      [1, 3],
      [4, 6],
      [5, 7],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7]
    ]
    const positions: number[] = []
    for (const [a, b] of edgePairs) {
      positions.push(corners[a].x, corners[a].y, corners[a].z)
      positions.push(corners[b].x, corners[b].y, corners[b].z)
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color, depthTest: false }))
  }

  // Automatically calculate jointAngles and tcpPose for all steps in the store (State Accumulator)
  useEffect(() => {
    const robot = robotRef.current
    if (!robot || isPlaying || steps.length === 0) return

    // Extract the raw structural config values chosen by the user
    const userConfig = steps.map((s) => ({
      type: s.type,
      jointIndex: s.jointIndex,
      rotateMode: s.rotateMode,
      angle: s.angle,
      tcpAxis: s.tcpAxis,
      moveMode: s.moveMode,
      distance: s.distance,
      doIndex: s.doIndex,
      doValue: s.doValue,
      delayMs: s.delayMs,
      speed: s.speed,
      acc: s.acc,
      ...(s.type === 'MoveJ' ? { jointAngles: s.jointAngles } : {}),
      ...(s.type === 'MoveL' ? { tcpPose: s.tcpPose, jointAngles: s.jointAngles } : {})
    }))
    const userConfigStr = JSON.stringify(userConfig)

    // CRITICAL PREVENT LOOP: If user configurations have not changed, block update recalculations!
    if (lastUserConfigRef.current === userConfigStr) {
      return
    }
    lastUserConfigRef.current = userConfigStr

    let tempJoints = [...DEFAULT_JOINT_ANGLES]
    let changesMade = false

    const updatedSteps = steps.map((step) => {
      let nextJoints = [...tempJoints]
      let nextTCP = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }
      let stepChanged = false
      const updatedFields: Partial<WorkflowStep> = {}

      if (step.type === 'MoveJ') {
        if (step.jointAngles) {
          nextJoints = [...step.jointAngles]
          nextTCP = computeFK(nextJoints, robot)

          if (isTcpPoseDifferent(step.tcpPose, nextTCP)) {
            updatedFields.tcpPose = nextTCP
            stepChanged = true
          }
        }
      } else if (step.type === 'MoveL') {
        if (step.tcpPose) {
          nextTCP = { ...step.tcpPose }
          const solved = computeIK(nextTCP, tempJoints, robot)
          if (solved) {
            nextJoints = solved
            if (
              !step.jointAngles ||
              step.jointAngles.some((val, i) => Math.abs(val - solved[i]) > 0.1)
            ) {
              updatedFields.jointAngles = solved
              stepChanged = true
            }
          }
        }
      } else if (step.type === 'RotateJoint') {
        const jIdx = (step.jointIndex || 1) - 1
        const angleVal = step.angle || 0
        if (step.rotateMode === 'absolute') {
          nextJoints[jIdx] = angleVal
        } else {
          nextJoints[jIdx] = tempJoints[jIdx] + angleVal
        }

        if (
          !step.jointAngles ||
          step.jointAngles.some((val, i) => Math.abs(val - nextJoints[i]) > 0.1)
        ) {
          updatedFields.jointAngles = toJointAngles(nextJoints)
          stepChanged = true
        }

        const fkTCP = computeFK(nextJoints, robot)
        if (isTcpPoseDifferent(step.tcpPose, fkTCP)) {
          updatedFields.tcpPose = fkTCP
          stepChanged = true
        }
      } else if (step.type === 'MoveTCP') {
        const curTCP = computeFK(tempJoints, robot)
        const axis = step.tcpAxis || 'Z'
        const dist = step.distance || 0

        nextTCP = { ...curTCP }
        const key = axis.toLowerCase() as 'x' | 'y' | 'z'
        if (step.moveMode === 'absolute') {
          nextTCP[key] = dist
        } else {
          nextTCP[key] = curTCP[key] + dist
        }

        const solved = computeIK(nextTCP, tempJoints, robot)
        if (solved) {
          nextJoints = solved
          if (
            !step.jointAngles ||
            step.jointAngles.some((val, i) => Math.abs(val - solved[i]) > 0.1)
          ) {
            updatedFields.jointAngles = solved
            stepChanged = true
          }
          if (isTcpPoseDifferent(step.tcpPose, nextTCP)) {
            updatedFields.tcpPose = nextTCP
            stepChanged = true
          }
        }
      } else {
        // Non-moving commands (DO / Wait / Gripper)
        if (
          !step.jointAngles ||
          step.jointAngles.some((val, i) => Math.abs(val - tempJoints[i]) > 0.1)
        ) {
          updatedFields.jointAngles = toJointAngles(tempJoints)
          stepChanged = true
        }
        const fkTCP = computeFK(tempJoints, robot)
        if (isTcpPoseDifferent(step.tcpPose, fkTCP)) {
          updatedFields.tcpPose = fkTCP
          stepChanged = true
        }
      }

      tempJoints = [...nextJoints]

      if (stepChanged) {
        changesMade = true
        return { ...step, ...updatedFields }
      }
      return step
    })

    if (changesMade) {
      useRobotStore.getState().reorderSteps(updatedSteps)
    }
  }, [steps, isRobotLoaded, isPlaying])

  // Initialize Scene, Camera, Renderer, Controls, Gizmos
  useEffect(() => {
    if (!containerRef.current) return

    const container = containerRef.current
    const width = Math.max(1, container.clientWidth)
    const height = Math.max(1, container.clientHeight)

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#141417') // Dark industrial bg
    sceneRef.current = scene

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
    camera.position.set(1.5, 1.5, 1.5)

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    const viewportPerformance = createViewportPerformanceMonitor({
      reporter: (snapshot) => {
        console.info('[ViewportPerformance]', {
          ...snapshot,
          robotCount: robotRefs.current.size,
          objectCount: loadedObjectsRef.current.size,
          debugHitbox: useSceneStore.getState().isDebugHitbox,
          workspaceMode: useRobotStore.getState().workspaceMode
        })
      }
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    // CSS canvas luôn phủ kín container.
    // Kích thước drawing buffer sẽ được cập nhật bởi ResizeObserver.
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'

    renderer.setSize(width, height, false)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap

    container.appendChild(renderer.domElement)
    // Orbit Controls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.maxPolarAngle = Math.PI / 2 - 0.05 // Don't go below ground
    controlsRef.current = controls

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4)
    scene.add(ambientLight)

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(2, 4, 3)
    dirLight.castShadow = true
    dirLight.shadow.mapSize.width = 1024
    dirLight.shadow.mapSize.height = 1024
    scene.add(dirLight)

    const dirLight2 = new THREE.DirectionalLight(0xaaccff, 0.3)
    dirLight2.position.set(-2, 2, -3)
    scene.add(dirLight2)

    // Helpers (Grid, Floor)
    const gridHelper = new THREE.GridHelper(10, 50, 0x3a3a45, 0x222226)
    gridHelper.position.y = 0
    scene.add(gridHelper)

    const axesHelper = new THREE.AxesHelper(0.5)
    scene.add(axesHelper)

    // Box Helper for selection visualization
    const boxHelper = new THREE.BoxHelper(new THREE.Object3D(), 0x3b82f6)
    boxHelper.visible = false
    scene.add(boxHelper)
    boxHelperRef.current = boxHelper

    // Create dummy target for IK Gizmo
    const dummyTarget = new THREE.Object3D()
    const indicatorGeom = new THREE.SphereGeometry(0.025, 16, 16)
    const indicatorMat = new THREE.MeshBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.7,
      depthTest: false
    })
    const indicatorMesh = new THREE.Mesh(indicatorGeom, indicatorMat)
    indicatorMesh.name = 'ik_target_indicator'
    dummyTarget.add(indicatorMesh)

    const cageGeom = new THREE.SphereGeometry(0.035, 8, 8)
    const cageMat = new THREE.MeshBasicMaterial({
      color: 0x00ffcc,
      wireframe: true,
      transparent: true,
      opacity: 0.3,
      depthTest: false
    })
    const cageMesh = new THREE.Mesh(cageGeom, cageMat)
    dummyTarget.add(cageMesh)

    dummyTarget.visible = false
    scene.add(dummyTarget)
    dummyTargetRef.current = dummyTarget

    // Measurement Line
    const lineGeom = new THREE.BufferGeometry()
    const lineMat = new THREE.LineDashedMaterial({
      color: 0x3b82f6,
      dashSize: 0.04,
      gapSize: 0.02,
      depthTest: false,
      transparent: true,
      opacity: 0.8
    })
    const measureLine = new THREE.Line(lineGeom, lineMat)
    measureLine.visible = false
    scene.add(measureLine)
    measureLineRef.current = measureLine

    // Self Measurement Line
    const selfLineGeom = new THREE.BufferGeometry()
    const selfLineMat = new THREE.LineDashedMaterial({
      color: 0xf59e0b, // amber/orange for self collision
      dashSize: 0.04,
      gapSize: 0.02,
      depthTest: false,
      transparent: true,
      opacity: 0.8
    })
    const selfMeasureLine = new THREE.Line(selfLineGeom, selfLineMat)
    selfMeasureLine.visible = false
    scene.add(selfMeasureLine)
    selfMeasureLineRef.current = selfMeasureLine

    // Transform Controls (IK, FK and Objects Gizmo)
    const transformControls = new TransformControls(camera, renderer.domElement)
    transformControls.size = 0.8
    transformControls.space = 'local'
    scene.add(transformControls.getHelper())
    transformControlsRef.current = transformControls

    const syncPlacementRobotSceneBinding = (): boolean => {
      const robotState = useRobotStore.getState()
      const placementRobotId = robotState.selectedRobotId

      if (!robotState.isRobotPlacementMode || !placementRobotId) {
        return false
      }

      const placementRobot = robotRefs.current.get(placementRobotId)
      const activeObject = transformControls.object

      if (!placementRobot || activeObject !== placementRobot) {
        return false
      }

      const storeRobot = robotState.robots.find((item) => item.id === placementRobotId)
      const nextSceneBinding = createSceneBindingFromRobotObject(
        placementRobot,
        storeRobot?.sceneBinding
      )

      robotState.updateRobotSceneBinding(placementRobotId, nextSceneBinding)
      return true
    }

    // Disable OrbitControls when dragging gizmo
    transformControls.addEventListener('dragging-changed', (event) => {
      controls.enabled = !event.value

      if (!event.value) {
        syncPlacementRobotSceneBinding()
      }
    })

    // Listen to changes on Gizmo dragging
    transformControls.addEventListener('objectChange', () => {
      const robotState = useRobotStore.getState()
      const activeRobotId = robotState.selectedRobotId
      const playing = activeRobotId
        ? (robotState.robotExecutionById[activeRobotId]?.isPlaying ?? false)
        : robotState.isPlaying

      if (playing) return
      if (syncPlacementRobotSceneBinding()) {
        return
      }

      const robot = robotRef.current
      if (!robot) return

      const activeObject = transformControls.object
      if (!activeObject) return
      // A. Check if currently manipulating an imported auxiliary 3D object
      const selectedObjId = useSceneStore.getState().selectedObjectId
      if (selectedObjId) {
        const threeObj = loadedObjectsRef.current.get(selectedObjId)
        if (threeObj && activeObject === threeObj) {
          const x = Math.round(threeObj.position.x * 1000)
          const y = Math.round(threeObj.position.y * 1000)
          const z = Math.round(threeObj.position.z * 1000)

          const rx = Math.round((threeObj.rotation.x * 180) / Math.PI)
          const ry = Math.round((threeObj.rotation.y * 180) / Math.PI)
          const rz = Math.round((threeObj.rotation.z * 180) / Math.PI)

          const sx = Math.round(threeObj.scale.x * 10) / 10
          const sy = Math.round(threeObj.scale.y * 10) / 10
          const sz = Math.round(threeObj.scale.z * 10) / 10

          useSceneStore
            .getState()
            .updateObjectTransform(selectedObjId, { x, y, z, rx, ry, rz, sx, sy, sz })
          return
        }
      }

      // B. Check if currently manipulating robot IK dummy target
      if (dummyTargetRef.current && activeObject === dummyTargetRef.current) {
        const dummy = dummyTargetRef.current
        const wristLink = robot.links['wrist3_link']
        const baseLink = robot.links['base_link']
        if (wristLink && baseLink) {
          dummy.updateMatrixWorld(true)

          const baseMatInv = new THREE.Matrix4().copy(baseLink.matrixWorld).invert()
          const relativeMat = new THREE.Matrix4().multiplyMatrices(baseMatInv, dummy.matrixWorld)

          const targetPos = new THREE.Vector3()
          const targetQuat = new THREE.Quaternion()
          const scale = new THREE.Vector3()
          relativeMat.decompose(targetPos, targetQuat, scale)

          const wristWorldPos = new THREE.Vector3()
          wristLink.getWorldPosition(wristWorldPos)
          const wristLocalPos = wristWorldPos.applyMatrix4(baseMatInv)

          const dist = targetPos.distanceTo(wristLocalPos)
          const maxDistance = 0.08 // 8cm
          const clampedTargetPos = targetPos.clone()
          if (dist > maxDistance) {
            const dir = new THREE.Vector3().subVectors(targetPos, wristLocalPos).normalize()
            clampedTargetPos.copy(wristLocalPos).addScaledVector(dir, maxDistance)
          }

          const robotState = useRobotStore.getState()
          const activeRobotId = robotState.selectedRobotId

          const currentAngles = activeRobotId
            ? (robotState.jointAnglesByRobotId[activeRobotId] ?? robotState.jointAngles)
            : robotState.jointAngles

          const newAngles = solveIK(clampedTargetPos, targetQuat, currentAngles, robot)

          if (!newAngles) {
            console.warn('Cartesian IK failed: no valid joint solution.')
            return
          }

          const appliedAngles = newAngles as JointAngles

          if (activeRobotId) {
            robotState.setJointAnglesForRobot(activeRobotId, appliedAngles)
          } else {
            robotState.setJointAngles(appliedAngles)
          }

          // Apply immediately so the arm follows the gizmo during dragging.
          updateRobotJoints(appliedAngles, robot)
        }
        return
      }

      // C. Check if currently manipulating a robot joint directly (FK)
      const selectedJoint = useRobotStore.getState().selectedJointName
      if (selectedJoint) {
        const jointObj = robot.joints[selectedJoint]
        if (jointObj && activeObject === jointObj) {
          const rad = jointObj.rotation.z
          const jointIdx = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].indexOf(selectedJoint)
          if (jointIdx !== -1) {
            const JOINT_LIMITS = [
              { min: -175, max: 175 },
              { min: -265, max: 85 },
              { min: -160, max: 160 },
              { min: -265, max: 85 },
              { min: -175, max: 175 },
              { min: -175, max: 175 }
            ]
            const limit = JOINT_LIMITS[jointIdx]
            let deg = (rad * 180) / Math.PI

            if (deg > 180) deg -= 360
            if (deg < -180) deg += 360

            const clampedDeg = Math.max(limit.min, Math.min(limit.max, deg))

            const currentAngles = [...useRobotStore.getState().jointAngles]
            currentAngles[jointIdx] = Math.round(clampedDeg * 10) / 10
            setJointAngles(toJointAngles(currentAngles))
          }
        }
      }
    })

    // Keyboard shortcuts listener for WASD movement and Gizmo transform modes
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Ignore when typing in input fields
      const activeTag = document.activeElement?.tagName
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') {
        return
      }

      const key = event.key.toLowerCase()
      if (['w', 'a', 's', 'd'].includes(key)) {
        keysPressedRef.current.add(key)
      }

      const selectedObjId = useSceneStore.getState().selectedObjectId
      if (selectedObjId && transformControls) {
        if (key === '1') {
          transformControls.setMode('translate')
        } else if (key === '2') {
          transformControls.setMode('rotate')
        } else if (key === '3') {
          transformControls.setMode('scale')
        }
      }
    }

    const handleKeyUp = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if (['w', 'a', 's', 'd'].includes(key)) {
        keysPressedRef.current.delete(key)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    // Click to select joints or imported 3D objects (Raycasting)
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()

    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.button !== 0 ||
        transformControls.dragging ||
        useRobotStore.getState().isIKMode ||
        useRobotStore.getState().isPlaying
      ) {
        return
      }

      const rect = renderer.domElement.getBoundingClientRect()
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1

      raycaster.setFromCamera(mouse, camera)

      // 1. Raycast imported auxiliary objects first
      const loadedMeshes = Array.from(loadedObjectsRef.current.values())
      const objectIntersects = raycaster.intersectObjects(loadedMeshes, true)

      if (objectIntersects.length > 0) {
        let hitObject: THREE.Object3D | null = objectIntersects[0].object
        let matchedId: string | null = null

        while (hitObject && hitObject !== scene) {
          for (const [id, threeObj] of loadedObjectsRef.current.entries()) {
            if (threeObj === hitObject) {
              matchedId = id
              break
            }
          }
          if (matchedId) break
          hitObject = hitObject.parent
        }

        if (matchedId) {
          useSceneStore.getState().setSelectedObjectId(matchedId)
          useRobotStore.getState().setSelectedJointName(null)
          return
        }
      }

      // 2. Raycast robot links
      // 2. Raycast robot links
      const loadedRobotEntries = Array.from(robotRefs.current.entries()).filter(
        ([, loadedRobot]) => loadedRobot.visible
      )

      const activeRobot = robotRef.current
      const robotObjects = loadedRobotEntries.map(([, loadedRobot]) => loadedRobot)

      if (robotObjects.length === 0 && activeRobot) {
        robotObjects.push(activeRobot)
      }

      const robotIntersects = raycaster.intersectObjects(robotObjects, true)

      if (robotIntersects.length > 0) {
        let node: THREE.Object3D | null = robotIntersects[0].object
        let clickedRobotId: string | null = null
        let clickedRobot: FairinoRobotObject | null = null

        while (node && node !== scene) {
          for (const [robotId, loadedRobot] of loadedRobotEntries) {
            if (node === loadedRobot) {
              clickedRobotId = robotId
              clickedRobot = loadedRobot
              break
            }
          }

          if (!clickedRobot && activeRobot && node === activeRobot) {
            clickedRobot = activeRobot
          }

          if (clickedRobot) break
          node = node.parent
        }

        if (clickedRobot) {
          const robotState = useRobotStore.getState()

          if (clickedRobotId && robotState.workspaceMode === 'factory') {
            robotState.selectRobot(clickedRobotId)
            robotState.setSelectedJointName(null)
            useSceneStore.getState().setSelectedObjectId(null)
            return
          }

          if (clickedRobotId && clickedRobot !== activeRobot) {
            robotState.selectRobot(clickedRobotId)
            robotState.setSelectedJointName(null)
            useSceneStore.getState().setSelectedObjectId(null)
            return
          }

          let obj: THREE.Object3D | null = robotIntersects[0].object
          let jointName: string | null = null

          while (obj && obj !== clickedRobot) {
            if (obj.name) {
              const nameLower = obj.name.toLowerCase()

              if (nameLower.includes('shoulder_link') || nameLower.includes('link1')) {
                jointName = 'j1'
                break
              }

              if (nameLower.includes('upperarm_link') || nameLower.includes('link2')) {
                jointName = 'j2'
                break
              }

              if (nameLower.includes('forearm_link') || nameLower.includes('link3')) {
                jointName = 'j3'
                break
              }

              if (nameLower.includes('wrist1_link') || nameLower.includes('link4')) {
                jointName = 'j4'
                break
              }

              if (nameLower.includes('wrist2_link') || nameLower.includes('link5')) {
                jointName = 'j5'
                break
              }

              if (nameLower.includes('wrist3_link') || nameLower.includes('link6')) {
                jointName = 'j6'
                break
              }
            }

            obj = obj.parent
          }

          if (jointName) {
            robotState.setSelectedJointName(jointName)
            useSceneStore.getState().setSelectedObjectId(null)
            return
          }
        }
      }

      // Click empty space clears selection
      useRobotStore.getState().setSelectedJointName(null)
      useSceneStore.getState().setSelectedObjectId(null)
    }

    renderer.domElement.addEventListener('pointerdown', onPointerDown)

    // Measurement and Hitbox update function in animation loop
    const updateMeasurementAndHitboxes = (): void => {
      const robot = robotRef.current
      const scene = sceneRef.current
      const measureLine = measureLineRef.current
      const selfMeasureLine = selfMeasureLineRef.current
      if (!robot || !scene || !measureLine || !selfMeasureLine) return

      const labelEl = document.getElementById('measure-label')
      const textEl = document.getElementById('measure-text')
      const selfLabelEl = document.getElementById('self-measure-label')
      const selfTextEl = document.getElementById('self-measure-text')

      const unit = useRobotStore.getState().lengthUnit
      const isDebug = useSceneStore.getState().isDebugHitbox
      const currentLanguage = useRobotStore.getState().language

      // 1. Gather active visible auxiliary objects (AABB is fine for non-articulated objects)
      const activeObjects: { id: string; name: string; box: THREE.Box3 }[] = []
      for (const [id, threeObj] of loadedObjectsRef.current.entries()) {
        const storeObj = useSceneStore.getState().objects.find((o) => o.id === id)
        if (storeObj && storeObj.visible) {
          const box = new THREE.Box3().setFromObject(threeObj)
          activeObjects.push({ id, name: storeObj.name, box })
        }
      }

      // 2. Compute OBB for each named URDF link, stopping traversal at link boundaries
      const allLinkObjs = new Set<THREE.Object3D>(
        Object.values(robot.links as Record<string, THREE.Object3D>)
      )
      const linkOBBMap = new Map<string, OBB>()
      if (robot.links) {
        for (const [name, linkObj] of Object.entries(
          robot.links as Record<string, THREE.Object3D>
        )) {
          const obb = computeLinkOBB(linkObj, allLinkObjs)
          if (obb) linkOBBMap.set(name, obb)
        }
      }

      // 3. Clear previous OBB wireframe helpers
      hitboxHelpersRef.current.forEach((h) => {
        scene.remove(h)
        h.geometry.dispose()
        ;(h.material as THREE.Material).dispose()
      })
      hitboxHelpersRef.current = []

      // 4. Render OBB wireframes if debug is active
      if (isDebug) {
        // Links skipped for ground collision (they're always near the ground by design)
        const SKIP_GROUND_HITBOX = ['base_link', 'shoulder_link']
        const GROUND_Y = 0.005 // 5mm threshold

        for (const [linkName, obb] of linkOBBMap.entries()) {
          const nameLower = linkName.toLowerCase()

          // Ground collision: check if any OBB corner dips below GROUND_Y
          let isCollidingGround = false
          if (!SKIP_GROUND_HITBOX.some((s) => nameLower.includes(s))) {
            const { center, halfSize, rotation } = obb
            outerGround: for (const sx of [-1, 1])
              for (const sy of [-1, 1])
                for (const sz of [-1, 1]) {
                  const corner = new THREE.Vector3(
                    sx * halfSize.x,
                    sy * halfSize.y,
                    sz * halfSize.z
                  )
                    .applyMatrix3(rotation)
                    .add(center)
                  if (corner.y < GROUND_Y) {
                    isCollidingGround = true
                    break outerGround
                  }
                }
          }

          // Auxiliary object collision
          let isCollidingObj = false
          if (!isCollidingGround) {
            for (const obj of activeObjects) {
              if (obb.intersectsBox3(obj.box)) {
                isCollidingObj = true
                break
              }
            }
          }

          // Self-collision with paired links
          let isCollidingSelf = false
          if (!isCollidingGround && !isCollidingObj) {
            for (const pair of SELF_COLLISION_PAIRS) {
              if (nameLower.includes(pair.a) || nameLower.includes(pair.b)) {
                const otherKey = nameLower.includes(pair.a) ? pair.b : pair.a
                let otherOBB: OBB | undefined
                for (const [k, o] of linkOBBMap.entries()) {
                  if (k.toLowerCase().includes(otherKey)) {
                    otherOBB = o
                    break
                  }
                }
                if (otherOBB && obb.intersectsOBB(otherOBB)) {
                  isCollidingSelf = true
                  break
                }
              }
            }
          }

          const color = isCollidingGround || isCollidingObj || isCollidingSelf ? 0xf43f5e : 0xeab308
          const wireframe = createOBBWireframe(obb, color)
          scene.add(wireframe)
          hitboxHelpersRef.current.push(wireframe)
        }

        // Auxiliary objects still shown as AABB Box3Helper
        for (const obj of activeObjects) {
          let isColliding = false
          for (const obb of linkOBBMap.values()) {
            if (obb.intersectsBox3(obj.box)) {
              isColliding = true
              break
            }
          }
          const color = isColliding ? 0xf43f5e : 0x10b981
          const helper = new THREE.Box3Helper(obj.box, new THREE.Color(color))
          scene.add(helper)
          hitboxHelpersRef.current.push(helper)
        }
      }

      // 5. Find target auxiliary object for arm-to-object distance measurement
      let targetObj: { id: string; name: string; box: THREE.Box3 } | null = null
      const selectedId = useSceneStore.getState().selectedObjectId
      if (selectedId) {
        targetObj = activeObjects.find((o) => o.id === selectedId) || null
      }
      if (!targetObj && activeObjects.length > 0) {
        let minD = Infinity
        activeObjects.forEach((obj) => {
          // Use rough center-to-center distance for picking target object
          const objCenter = new THREE.Vector3()
          new THREE.Box3().copy(obj.box).getCenter(objCenter)
          const baseOBB = linkOBBMap.get('base_link')
          if (baseOBB) {
            const d = baseOBB.center.distanceTo(objCenter)
            if (d < minD) {
              minD = d
              targetObj = obj
            }
          } else {
            targetObj = obj
          }
        })
      }

      // 6. Arm-to-object distance measurement using OBB vs AABB
      const SKIP_LINKS_OBJ = ['base_link', 'shoulder_link']
      if (targetObj && linkOBBMap.size > 0) {
        let minDistance = Infinity
        let bestPoints: { pointA: THREE.Vector3; pointB: THREE.Vector3 } | null = null
        let closestLinkName = ''

        for (const [linkName, obb] of linkOBBMap.entries()) {
          const nameLower = linkName.toLowerCase()
          if (SKIP_LINKS_OBJ.some((s) => nameLower.includes(s))) continue

          // Approximate OBB-to-Box3 closest points:
          // clamp OBB center onto the aux box, then clamp that point onto the OBB
          const pointOnBox = targetObj.box.clampPoint(obb.center, new THREE.Vector3())
          const pointOnOBB = new THREE.Vector3()
          obb.clampPoint(pointOnBox, pointOnOBB)
          const dist = pointOnOBB.distanceTo(pointOnBox)

          if (dist < minDistance) {
            minDistance = dist
            bestPoints = { pointA: pointOnOBB, pointB: pointOnBox }
            closestLinkName = linkName
          }
        }

        if (bestPoints) {
          measureLine.geometry.setFromPoints([bestPoints.pointA, bestPoints.pointB])
          measureLine.computeLineDistances()
          measureLine.visible = true

          const distanceMm = Math.round(minDistance * 1000)

          if (labelEl && textEl && containerRef.current) {
            const midPoint = new THREE.Vector3()
              .addVectors(bestPoints.pointA, bestPoints.pointB)
              .multiplyScalar(0.5)
            midPoint.project(camera)
            const w = containerRef.current.clientWidth
            const h = containerRef.current.clientHeight
            labelEl.style.left = `${(midPoint.x * 0.5 + 0.5) * w}px`
            labelEl.style.top = `${(-midPoint.y * 0.5 + 0.5) * h}px`
            labelEl.style.display = 'flex'

            const linkViNames: Record<string, string> = {
              upperarm_link: 'Bắp tay',
              forearm_link: 'Khuỷu tay',
              wrist1_link: 'Cổ tay 1',
              wrist2_link: 'Cổ tay 2',
              wrist3_link: 'Cổ tay 3'
            }
            const linkEnNames: Record<string, string> = {
              upperarm_link: 'Upper Arm',
              forearm_link: 'Forearm',
              wrist1_link: 'Wrist 1',
              wrist2_link: 'Wrist 2',
              wrist3_link: 'Wrist 3'
            }
            const nameMap = currentLanguage === 'vi' ? linkViNames : linkEnNames
            const cleanName = Object.keys(nameMap).find((k) =>
              closestLinkName.toLowerCase().includes(k)
            )
              ? nameMap[
                  Object.keys(nameMap).find((k) => closestLinkName.toLowerCase().includes(k))!
                ]
              : closestLinkName
            const valStr = unit === 'm' ? `${(distanceMm / 1000).toFixed(3)} m` : `${distanceMm} mm`
            textEl.innerHTML = `${cleanName} ↔ ${targetObj.name}: ${valStr}`
          }
        }
      } else {
        measureLine.visible = false
        if (labelEl) labelEl.style.display = 'none'
      }

      // 7. Self-Distance measurement between non-adjacent robot links using OBB
      if (linkOBBMap.size > 0) {
        let minSelfDistance = Infinity
        let bestSelfPoints: { pointA: THREE.Vector3; pointB: THREE.Vector3 } | null = null
        let selfLinkA = ''
        let selfLinkB = ''

        for (const pair of SELF_COLLISION_PAIRS) {
          let obbA: OBB | undefined
          let keyA = ''
          let obbB: OBB | undefined
          let keyB = ''
          for (const [key, o] of linkOBBMap.entries()) {
            const kl = key.toLowerCase()
            if (kl.includes(pair.a)) {
              obbA = o
              keyA = key
            }
            if (kl.includes(pair.b)) {
              obbB = o
              keyB = key
            }
          }
          if (obbA && obbB) {
            const res = getOBBDistance(obbA, obbB)
            if (res.distance < minSelfDistance) {
              minSelfDistance = res.distance
              bestSelfPoints = res
              selfLinkA = keyA
              selfLinkB = keyB
            }
          }
        }

        if (bestSelfPoints && minSelfDistance < Infinity) {
          selfMeasureLine.geometry.setFromPoints([bestSelfPoints.pointA, bestSelfPoints.pointB])
          selfMeasureLine.computeLineDistances()
          selfMeasureLine.visible = true

          const selfDistanceMm = Math.round(minSelfDistance * 1000)

          if (selfLabelEl && selfTextEl && containerRef.current) {
            const midPoint = new THREE.Vector3()
              .addVectors(bestSelfPoints.pointA, bestSelfPoints.pointB)
              .multiplyScalar(0.5)
            midPoint.project(camera)
            const w = containerRef.current.clientWidth
            const h = containerRef.current.clientHeight
            selfLabelEl.style.left = `${(midPoint.x * 0.5 + 0.5) * w}px`
            selfLabelEl.style.top = `${(-midPoint.y * 0.5 + 0.5) * h}px`
            selfLabelEl.style.display = 'flex'

            const linkViNames: Record<string, string> = {
              shoulder_link: 'Khớp vai',
              upperarm_link: 'Bắp tay',
              forearm_link: 'Khuỷu tay',
              wrist1_link: 'Cổ tay 1',
              wrist2_link: 'Cổ tay 2',
              wrist3_link: 'Cổ tay 3'
            }
            const linkEnNames: Record<string, string> = {
              shoulder_link: 'Shoulder',
              upperarm_link: 'Upper Arm',
              forearm_link: 'Forearm',
              wrist1_link: 'Wrist 1',
              wrist2_link: 'Wrist 2',
              wrist3_link: 'Wrist 3'
            }
            const nameMap = currentLanguage === 'vi' ? linkViNames : linkEnNames
            const cleanA = Object.keys(nameMap).find((k) => selfLinkA.toLowerCase().includes(k))
              ? nameMap[Object.keys(nameMap).find((k) => selfLinkA.toLowerCase().includes(k))!]
              : selfLinkA
            const cleanB = Object.keys(nameMap).find((k) => selfLinkB.toLowerCase().includes(k))
              ? nameMap[Object.keys(nameMap).find((k) => selfLinkB.toLowerCase().includes(k))!]
              : selfLinkB

            const valStr =
              unit === 'm' ? `${(selfDistanceMm / 1000).toFixed(3)} m` : `${selfDistanceMm} mm`
            selfTextEl.innerHTML = `${cleanA} ↔ ${cleanB}: ${valStr}`
          }
        } else {
          selfMeasureLine.visible = false
          if (selfLabelEl) selfLabelEl.style.display = 'none'
        }
      } else {
        selfMeasureLine.visible = false
        if (selfLabelEl) selfLabelEl.style.display = 'none'
      }
    }

    // Animation Loop
    let animationFrameId: number
    // Real-time camera navigation via WASD keys on horizontal plane
    const updateWASDNavigation = (): void => {
      const keys = keysPressedRef.current
      if (keys.size === 0) return

      const moveSpeed = 0.015 // move speed per frame
      const tempDir = new THREE.Vector3()
      const tempRight = new THREE.Vector3()

      // Horizontal camera forward direction
      camera.getWorldDirection(tempDir)
      tempDir.y = 0
      tempDir.normalize()

      // Horizontal camera right direction
      tempRight.crossVectors(tempDir, camera.up).normalize()

      const delta = new THREE.Vector3()
      if (keys.has('w')) delta.addScaledVector(tempDir, moveSpeed)
      if (keys.has('s')) delta.addScaledVector(tempDir, -moveSpeed)
      if (keys.has('d')) delta.addScaledVector(tempRight, moveSpeed)
      if (keys.has('a')) delta.addScaledVector(tempRight, -moveSpeed)

      camera.position.add(delta)
      controls.target.add(delta)
      controls.update()
    }

    const animate = (frameTimestampMs: number): void => {
      animationFrameId = requestAnimationFrame(animate)
      viewportPerformance.beginFrame(frameTimestampMs)

      controls.update()

      if (boxHelperRef.current && boxHelperRef.current.visible) {
        boxHelperRef.current.update()
      }

      updateWASDNavigation()

      let stageStartedAtMs = viewportPerformance.beginStage()
      checkCollisions(frameTimestampMs)
      viewportPerformance.endStage('collision', stageStartedAtMs)

      stageStartedAtMs = viewportPerformance.beginStage()
      updateMeasurementAndHitboxes()
      viewportPerformance.endStage('measurement', stageStartedAtMs)

      stageStartedAtMs = viewportPerformance.beginStage()
      renderer.render(scene, camera)
      viewportPerformance.endStage('render', stageStartedAtMs)

      viewportPerformance.endFrame()
    }

    animationFrameId = requestAnimationFrame(animate)

    // Resize Handler
    // Theo dõi chính container thay vì chỉ theo dõi kích thước cửa sổ.
    // Khi chuyển Factory/Train, sidebar thay đổi làm container đổi width
    // nhưng không tạo window resize event.
    const resizeViewport = (): void => {
      const rect = container.getBoundingClientRect()
      const nextWidth = Math.max(1, Math.floor(rect.width))
      const nextHeight = Math.max(1, Math.floor(rect.height))

      camera.aspect = nextWidth / nextHeight
      camera.updateProjectionMatrix()

      renderer.setSize(nextWidth, nextHeight, false)
    }

    const resizeObserver = new ResizeObserver(() => {
      resizeViewport()
    })

    resizeObserver.observe(container)

    // Đồng bộ kích thước ngay sau khi khởi tạo.
    resizeViewport()

    const robotMaterialSnapshots = robotMaterialSnapshotsByRobotIdRef.current
    const robotSafetyVisualStates = robotSafetyVisualStateByRobotIdRef.current
    const collisionCandidates = collisionCandidateByRobotIdRef.current
    const groundVerticesByLinkName = groundVerticesByLinkNameRef.current

    // Clean up
    return () => {
      if (sceneRef.current === scene) {
        sceneRef.current = null
      }
      cancelAnimationFrame(animationFrameId)
      resizeObserver.disconnect()

      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.dispose()
      transformControls.dispose()
      robotMaterialSnapshots.clear()
      robotSafetyVisualStates.clear()
      collisionCandidates.clear()
      groundVerticesByLinkName.clear()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
    // This effect owns the Three.js scene lifecycle and must run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function detectRobotCollision(
    robot: FairinoRobotObject,
    activeObjects: readonly { id: string; box: THREE.Box3 }[]
  ): DetectedRobotCollision | null {
    const allLinkObjects = new Set<THREE.Object3D>(
      Object.values(robot.links as Record<string, THREE.Object3D>)
    )
    const linkObbs = new Map<string, OBB>()

    for (const [name, linkObject] of Object.entries(
      robot.links as Record<string, THREE.Object3D>
    )) {
      const obb = computeLinkOBB(linkObject, allLinkObjects)
      if (obb) linkObbs.set(name, obb)
    }

    const groundIgnoredLinks = ['base_link', 'shoulder_link']
    for (const [linkName, obb] of linkObbs) {
      if (groundIgnoredLinks.some((value) => linkName.toLowerCase().includes(value))) continue

      const { center, halfSize, rotation } = obb
      let minimumY = Infinity

      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (const sz of [-1, 1]) {
            const corner = new THREE.Vector3(sx * halfSize.x, sy * halfSize.y, sz * halfSize.z)
              .applyMatrix3(rotation)
              .add(center)
            minimumY = Math.min(minimumY, corner.y)
          }

      if (minimumY < -GROUND_PENETRATION_TOLERANCE_METERS) {
        const exactMinimumY = getExactLinkMinimumWorldY(
          linkName,
          robot.links[linkName],
          allLinkObjects
        )

        if (exactMinimumY >= -GROUND_PENETRATION_TOLERANCE_METERS) {
          continue
        }

        return {
          kind: 'ground',
          signature: `ground:${linkName}`,
          objectIds: [],
          message: `Robot link ${linkName} intersects the ground safety plane (confirmed mesh contact).`
        }
      }
    }

    for (const pair of SELF_COLLISION_PAIRS) {
      let firstObb: OBB | undefined
      let secondObb: OBB | undefined

      for (const [linkName, obb] of linkObbs) {
        const normalizedLinkName = linkName.toLowerCase()
        if (normalizedLinkName.includes(pair.a)) firstObb = obb
        if (normalizedLinkName.includes(pair.b)) secondObb = obb
      }

      if (firstObb && secondObb && firstObb.intersectsOBB(secondObb)) {
        return {
          kind: 'self',
          signature: `self:${pair.a}:${pair.b}`,
          objectIds: [],
          message: `Robot self-collision detected between ${pair.a} and ${pair.b}.`
        }
      }
    }

    for (const activeObject of activeObjects) {
      for (const [linkName, obb] of linkObbs) {
        if (linkName.toLowerCase().includes('base_link')) continue

        if (obb.intersectsBox3(activeObject.box)) {
          return {
            kind: 'obstacle',
            signature: `obstacle:${linkName}:${activeObject.id}`,
            objectIds: [activeObject.id],
            message: `Robot link ${linkName} collided with scene object ${activeObject.id}.`
          }
        }
      }
    }

    return null
  }

  // Compatibility collision pass. Phase 7 replaces this with cached broad/narrow phases.
  function checkCollisions(frameTimestampMs: number): void {
    if (frameTimestampMs - lastCollisionCheckAtMsRef.current < COLLISION_CHECK_INTERVAL_MS) {
      return
    }
    lastCollisionCheckAtMsRef.current = frameTimestampMs

    const sceneState = useSceneStore.getState()
    const activeObjects = Array.from(loadedObjectsRef.current.entries())
      .map(([id, object]) => ({
        id,
        object,
        sceneObject: sceneState.objects.find((candidate) => candidate.id === id)
      }))
      .filter((entry) => entry.sceneObject?.visible)
      .map((entry) => ({ id: entry.id, box: new THREE.Box3().setFromObject(entry.object) }))

    const visibleRobots = Array.from(robotRefs.current.entries()).filter(
      ([, robot]) => robot.visible
    )
    const visibleRobotIds = new Set(visibleRobots.map(([robotId]) => robotId))

    for (const robotId of collisionCandidateByRobotIdRef.current.keys()) {
      if (!visibleRobotIds.has(robotId)) {
        collisionCandidateByRobotIdRef.current.delete(robotId)
      }
    }

    for (const [robotId, robot] of visibleRobots) {
      const collision = detectRobotCollision(robot, activeObjects)

      if (collision) {
        const signature = collision.signature
        const previousCandidate = collisionCandidateByRobotIdRef.current.get(robotId)
        const consecutiveSamples =
          previousCandidate?.signature === signature ? previousCandidate.consecutiveSamples + 1 : 1

        collisionCandidateByRobotIdRef.current.set(robotId, {
          signature,
          consecutiveSamples
        })

        if (consecutiveSamples < COLLISION_CONFIRMATION_SAMPLES) {
          continue
        }

        reportRobotSafetyContact(robotId, {
          level: 'collision',
          kind: collision.kind,
          objectIds: collision.objectIds,
          message: collision.message
        })
        continue
      }

      collisionCandidateByRobotIdRef.current.delete(robotId)

      const currentContact = getRobotSafetyContact(robotId)
      if (
        currentContact?.level === 'collision' &&
        ['ground', 'self', 'obstacle'].includes(currentContact.kind)
      ) {
        clearRobotSafetyContact(robotId)
      }
    }

    // Preserve the local preview warning display without using it as an execution decision.
    if (visibleRobots.length === 0 && previewRobotRef.current?.visible) {
      const previewCollision = detectRobotCollision(previewRobotRef.current, activeObjects)
      if (sceneState.collisionWarning !== Boolean(previewCollision)) {
        sceneState.setCollisionWarning(Boolean(previewCollision))
      }
    } else {
      const latestSceneState = useSceneStore.getState()
      const hasRobotCollision = Object.values(latestSceneState.robotContactsById).some(
        (contact) => contact.level === 'collision'
      )

      if (latestSceneState.collisionWarning !== hasRobotCollision) {
        latestSceneState.setCollisionWarning(hasRobotCollision)
      }
    }
  }

  // Synchronize 3D models in store with Three.js scene
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    const loadedMap = loadedObjectsRef.current

    // 1. Load newly added objects
    objects.forEach((obj) => {
      if (!loadedMap.has(obj.id)) {
        if (obj.fileType === 'stl') {
          const stlLoader = new STLLoader()
          stlLoader.load(obj.url, (geometry) => {
            const material = new THREE.MeshStandardMaterial({
              color: 0x90caf9,
              roughness: 0.5,
              metalness: 0.2
            })
            const mesh = new THREE.Mesh(geometry, material)
            mesh.castShadow = true
            mesh.receiveShadow = true

            updateThreeObjTransform(mesh, obj.transform)
            mesh.visible = obj.visible

            scene.add(mesh)
            loadedMap.set(obj.id, mesh)

            updateSelection()
          })
        } else {
          const gltfLoader = new GLTFLoader()
          gltfLoader.load(obj.url, (gltf) => {
            const model = gltf.scene
            model.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true
                child.receiveShadow = true
              }
            })

            updateThreeObjTransform(model, obj.transform)
            model.visible = obj.visible

            scene.add(model)
            loadedMap.set(obj.id, model)

            updateSelection()
          })
        }
      } else {
        // 2. Update existing object transform & visibility
        const threeObj = loadedMap.get(obj.id)
        if (threeObj) {
          const transformControls = transformControlsRef.current
          const isDraggingThis =
            transformControls && transformControls.dragging && transformControls.object === threeObj

          if (!isDraggingThis) {
            updateThreeObjTransform(threeObj, obj.transform)
          }
          threeObj.visible = obj.visible
        }
      }
    })

    // 3. Remove deleted objects
    for (const id of loadedMap.keys()) {
      if (!objects.some((o) => o.id === id)) {
        const threeObj = loadedMap.get(id)
        if (threeObj) {
          scene.remove(threeObj)
          loadedMap.delete(id)
        }
      }
    }

    updateSelection()
    // Object loading is driven by scene objects; selection is refreshed by a separate effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objects])

  // Update selection outline
  function updateSelection(): void {
    const boxHelper = boxHelperRef.current
    if (!boxHelper) return

    if (selectedObjectId) {
      const threeObj = loadedObjectsRef.current.get(selectedObjectId)
      if (threeObj) {
        boxHelper.setFromObject(threeObj)
        boxHelper.visible = true
        return
      }
    }
    boxHelper.visible = false
  }

  // Update selection outline when selection changes
  useEffect(() => {
    updateSelection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedObjectId, objects])

  // Sync transform helper values (mm/degrees to meters/radians)
  function updateThreeObjTransform(threeObj: THREE.Object3D, transform: Transform3D): void {
    threeObj.position.set(transform.x / 1000, transform.y / 1000, transform.z / 1000)
    threeObj.rotation.set(
      (transform.rx * Math.PI) / 180,
      (transform.ry * Math.PI) / 180,
      (transform.rz * Math.PI) / 180
    )
    threeObj.scale.set(transform.sx, transform.sy, transform.sz)
  }

  // Highlight joint links
  function highlightJointLink(selectedJoint: string | null): void {
    const robot = robotRef.current
    if (!robot) return

    const robotEntry = Array.from(robotRefs.current.entries()).find(
      ([, loadedRobot]) => loadedRobot === robot
    )
    const robotId = robotEntry?.[0]

    if (robotId && getRobotSafetyVisualState(robotId) !== 'normal') {
      applyRobotSafetyVisual(robotId, true)
      return
    }

    const jointToLinkMap: Record<string, string> = {
      j1: 'shoulder_link',
      j2: 'upperarm_link',
      j3: 'forearm_link',
      j4: 'wrist1_link',
      j5: 'wrist2_link',
      j6: 'wrist3_link'
    }

    const JOINT_LIMITS = [
      { min: -175, max: 175 },
      { min: -265, max: 85 },
      { min: -150, max: 150 },
      { min: -265, max: 85 },
      { min: -175, max: 175 },
      { min: -175, max: 175 }
    ]

    const currentAngles = useRobotStore.getState().jointAngles

    robot.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) {
        return
      }

      let matchedJoint: string | null = null
      for (const [jointName, linkName] of Object.entries(jointToLinkMap)) {
        if (child.name && child.name.toLowerCase().includes(linkName.toLowerCase())) {
          matchedJoint = jointName
          break
        }
      }

      if (!matchedJoint) {
        return
      }

      const jointIdx = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].indexOf(matchedJoint)
      const limit = JOINT_LIMITS[jointIdx]
      const angleVal = currentAngles[jointIdx]

      const isAtLimit =
        Math.abs(angleVal - limit.min) <= 0.5 || Math.abs(angleVal - limit.max) <= 0.5

      const highlightColor = isAtLimit
        ? 0xf43f5e
        : matchedJoint === selectedJoint
          ? 0x0284c7
          : 0x000000

      const highlightIntensity = isAtLimit ? 0.8 : matchedJoint === selectedJoint ? 0.5 : 0
      const materials = Array.isArray(child.material) ? child.material : [child.material]

      for (const material of materials) {
        if (isHighlightableMaterial(material)) {
          material.emissive.set(highlightColor)
          material.emissiveIntensity = highlightIntensity
        }
      }
    })
  }

  // Sync TransformControls visibility and attachments based on isIKMode and isPlaying
  useEffect(() => {
    const transformControls = transformControlsRef.current
    const dummyTarget = dummyTargetRef.current
    const robot = robotRef.current

    if (!transformControls || !dummyTarget) return

    if (!robot || isPlaying) {
      transformControls.detach()
      transformControls.getHelper().visible = false
      dummyTarget.visible = false
      highlightJointLink(null)
      return
    }

    const placementRobot = selectedRobotId ? robotRefs.current.get(selectedRobotId) : null

    if (isRobotPlacementMode && placementRobot) {
      dummyTarget.visible = false
      highlightJointLink(null)

      const isTranslateMode = robotPlacementTransformMode === 'translate'

      transformControls.setMode(robotPlacementTransformMode)
      transformControls.space = 'world'
      transformControls.showX = isTranslateMode
      transformControls.showY = !isTranslateMode
      transformControls.showZ = isTranslateMode

      if (transformControls.object !== placementRobot) {
        transformControls.attach(placementRobot)
      }

      transformControls.getHelper().visible = true
      return
    }

    if (isIKMode) {
      highlightJointLink(null)

      // Only copy the wristLink position to the dummyTarget if we are not actively dragging it
      if (!transformControls.dragging) {
        const wristLink = robot.links['wrist3_link']
        if (wristLink) {
          const wristWorldPos = new THREE.Vector3()
          const wristWorldQuat = new THREE.Quaternion()
          wristLink.getWorldPosition(wristWorldPos)
          wristLink.getWorldQuaternion(wristWorldQuat)

          dummyTarget.position.copy(wristWorldPos)
          dummyTarget.quaternion.copy(wristWorldQuat)
          dummyTarget.updateMatrixWorld(true)
        }
      }

      transformControls.setMode('translate')
      transformControls.space = 'local'
      transformControls.showX = true
      transformControls.showY = true
      transformControls.showZ = true

      // Only attach if it's not already attached to prevent resetting the dragging state offset
      if (transformControls.object !== dummyTarget) {
        transformControls.attach(dummyTarget)
      }
      transformControls.getHelper().visible = true
      dummyTarget.visible = true
    } else if (selectedJointName) {
      dummyTarget.visible = false
      highlightJointLink(selectedJointName)

      const jointObj = robot.joints[selectedJointName]
      if (jointObj) {
        transformControls.setMode('rotate')
        transformControls.space = 'local'
        transformControls.showX = false
        transformControls.showY = false
        transformControls.showZ = true

        // Only attach if it's not already attached to prevent resetting the dragging state offset
        if (transformControls.object !== jointObj) {
          transformControls.attach(jointObj)
        }
        transformControls.getHelper().visible = true
      } else {
        transformControls.detach()
        transformControls.getHelper().visible = false
      }
    } else if (selectedObjectId) {
      dummyTarget.visible = false
      highlightJointLink(null)

      const threeObj = loadedObjectsRef.current.get(selectedObjectId)
      if (threeObj) {
        transformControls.space = 'local'
        transformControls.showX = true
        transformControls.showY = true
        transformControls.showZ = true

        // Only attach if it's not already attached to prevent resetting the dragging state offset
        if (transformControls.object !== threeObj) {
          transformControls.attach(threeObj)
        }
        transformControls.getHelper().visible = true
      } else {
        transformControls.detach()
        transformControls.getHelper().visible = false
      }
    } else {
      highlightJointLink(null)
      transformControls.detach()
      transformControls.getHelper().visible = false
    }
    // highlightJointLink reads stable refs and current stores; including it would rerun every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isIKMode,
    isRobotPlacementMode,
    robotPlacementTransformMode,
    isRobotLoaded,
    isPlaying,
    selectedJointName,
    selectedObjectId,
    selectedRobotId
  ])

  // Update robot joints when jointAngles state changes
  useEffect(() => {
    if (robotRef.current) {
      updateRobotJoints(jointAngles, robotRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jointAngles])

  // Sync selectedRobotId and toggle home pose for non-active robots.
  // If no backend robot is available yet, keep the local preview robot active.
  useEffect(() => {
    const activeRobot = selectedRobotId
      ? robotRefs.current.get(selectedRobotId) || null
      : robots.length === 0
        ? previewRobotRef.current
        : null

    robotRef.current = activeRobot
    setIsRobotLoaded(!!activeRobot)

    for (const [id, robot] of robotRefs.current.entries()) {
      robot.visible = workspaceMode === 'factory' || id === selectedRobotId

      const robotAngles =
        id === selectedRobotId
          ? jointAngles
          : (jointAnglesByRobotId[id] ?? [...DEFAULT_JOINT_ANGLES])

      updateRobotJoints(robotAngles, robot)
    }

    if (!selectedRobotId && robots.length === 0 && previewRobotRef.current) {
      previewRobotRef.current.visible = true
      updateRobotJoints(jointAngles, previewRobotRef.current)
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jointAngles, jointAnglesByRobotId, robots.length, selectedRobotId, workspaceMode])

  // Local preview robot for logged-out / empty backend state.
  // This robot is visual-only and is removed as soon as backend robots exist.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    if (robots.length > 0) {
      previewRobotLoadGenerationRef.current += 1
      previewRobotLoadingRef.current = false

      const previewRobot = previewRobotRef.current

      if (previewRobot) {
        scene.remove(previewRobot)
        disposeRobotObject(previewRobot)
        previewRobotRef.current = null

        if (robotRef.current === previewRobot) {
          robotRef.current = null
          setIsRobotLoaded(false)
        }
      }

      return
    }

    if (previewRobotRef.current || previewRobotLoadingRef.current) {
      return
    }

    const loadGeneration = previewRobotLoadGenerationRef.current + 1

    previewRobotLoadGenerationRef.current = loadGeneration
    previewRobotLoadingRef.current = true

    const loader = new URDFLoader()

    loader.packages = {
      fairino_description: './fairino_description'
    }

    loader.load(
      './fairino_description/urdf/fairino5_v6.urdf',
      (loadedRobot) => {
        const loadIsCurrent =
          previewRobotLoadGenerationRef.current === loadGeneration &&
          sceneRef.current === scene &&
          robotsRef.current.length === 0

        if (!loadIsCurrent) {
          disposeRobotObject(loadedRobot)
          return
        }

        previewRobotLoadingRef.current = false

        applyRobotSceneBinding(loadedRobot, null)

        loadedRobot.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true
            child.receiveShadow = true

            const material = child.material

            if (!Array.isArray(material)) {
              material.roughness = 0.4
              material.metalness = 0.6
            }
          }
        })

        scene.add(loadedRobot)

        previewRobotRef.current = loadedRobot
        robotRef.current = loadedRobot

        setIsRobotLoaded(true)

        updateRobotJoints(useRobotStore.getState().jointAngles, loadedRobot)
      },
      undefined,
      (error) => {
        if (previewRobotLoadGenerationRef.current === loadGeneration) {
          previewRobotLoadingRef.current = false
          console.error('An error occurred loading preview URDF:', error)
        }
      }
    )

    return () => {
      if (previewRobotLoadGenerationRef.current === loadGeneration) {
        previewRobotLoadGenerationRef.current += 1
        previewRobotLoadingRef.current = false
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robots.length])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    const existingIds = new Set(robotRefs.current.keys())
    const nextIds = new Set(robots.map((r) => r.id))

    // 1. Remove robots no longer in store
    for (const id of existingIds) {
      if (!nextIds.has(id)) {
        const robotObj = robotRefs.current.get(id)
        if (robotObj) {
          scene.remove(robotObj)
          removeRobotMaterialCache(id)
          disposeRobotObject(robotObj)
          unregisterLoadedRobotMoveLRunner(id)
        }
        robotRefs.current.delete(id)
        collisionCandidateByRobotIdRef.current.delete(id)
        removeRobotSafetyState(id)
        if (selectedRobotId === id) {
          robotRef.current = null
          setIsRobotLoaded(false)
        }
      }
    }

    // Clean up loading flag if robot was removed from store while loading
    for (const loadingId of Array.from(loadingRobotIdsRef.current)) {
      if (!nextIds.has(loadingId)) {
        loadingRobotIdsRef.current.delete(loadingId)
      }
    }

    // 2. Load new robots or update existing placement
    robots.forEach((robot) => {
      const existingRobot = robotRefs.current.get(robot.id)
      if (existingRobot) {
        applyRobotSceneBinding(existingRobot, robot.sceneBinding)
      } else if (!loadingRobotIdsRef.current.has(robot.id)) {
        loadingRobotIdsRef.current.add(robot.id)

        const loader = new URDFLoader()
        loader.packages = {
          fairino_description: './fairino_description'
        }

        loader.load(
          './fairino_description/urdf/fairino5_v6.urdf',
          (loadedRobot) => {
            // Check race conditions: if robot was removed from store or already loaded
            const stillExists = robotsRef.current.some((item) => item.id === robot.id)
            const alreadyLoaded = robotRefs.current.has(robot.id)

            if (!stillExists || alreadyLoaded) {
              disposeRobotObject(loadedRobot)
              loadingRobotIdsRef.current.delete(robot.id)
              return
            }

            applyRobotSceneBinding(loadedRobot, robot.sceneBinding)

            loadedRobot.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.castShadow = true
                child.receiveShadow = true

                const material = child.material
                if (!Array.isArray(material)) {
                  material.roughness = 0.4
                  material.metalness = 0.6
                }
              }
            })

            cacheRobotMaterials(robot.id, loadedRobot)

            loadedRobot.visible = workspaceMode === 'factory' || robot.id === selectedRobotId

            scene.add(loadedRobot)
            robotRefs.current.set(robot.id, loadedRobot)
            registerLoadedRobotMoveLRunner(robot.id, loadedRobot)
            applyRobotSafetyVisual(robot.id, true)
            loadingRobotIdsRef.current.delete(robot.id)
            // Initial joints position sync
            const robotAngles =
              robot.id === selectedRobotId
                ? jointAngles
                : (jointAnglesByRobotId[robot.id] ?? [...DEFAULT_JOINT_ANGLES])

            if (robot.id === selectedRobotId) {
              robotRef.current = loadedRobot
              setIsRobotLoaded(true)
            }

            updateRobotJoints(robotAngles, loadedRobot)
          },
          undefined,
          (error) => {
            console.error('An error occurred loading URDF:', error)
            loadingRobotIdsRef.current.delete(robot.id)
          }
        )
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robots, selectedRobotId, jointAnglesByRobotId])

  // Helper function to update joint angles, calculate TCP Pose and snap Gizmo Target
  function updateRobotJoints(angles: number[], targetRobot?: FairinoRobotObject | null): void {
    const robot = targetRobot !== undefined ? targetRobot : robotRef.current
    const dummyTarget = dummyTargetRef.current
    if (!robot) return

    const jointNames = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6']

    jointNames.forEach((name, index) => {
      const joint = robot.joints[name]
      if (!joint) return

      const angleValue = Number.isNaN(angles[index]) ? 0 : angles[index]
      joint.setJointValue((angleValue * Math.PI) / 180)
    })

    robot.updateMatrixWorld(true)

    let robotId: string | null = null

    for (const [id, loadedRobot] of robotRefs.current.entries()) {
      if (loadedRobot === robot) {
        robotId = id
        break
      }
    }

    const baseLink = robot.links['base_link']
    const wristLink = robot.links['wrist3_link']
    if (!baseLink || !wristLink) return

    const baseMatrixInverse = new THREE.Matrix4().copy(baseLink.matrixWorld).invert()

    const relativeMatrix = new THREE.Matrix4().multiplyMatrices(
      baseMatrixInverse,
      wristLink.matrixWorld
    )

    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()

    relativeMatrix.decompose(position, quaternion, scale)

    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ')
    const toMillimeters = (value: number): number =>
      Number.isNaN(value) ? 0 : Math.round(value * 10000) / 10
    const toDegrees = (value: number): number =>
      Number.isNaN(value) ? 0 : Math.round(((value * 180) / Math.PI) * 10) / 10

    const nextTcpPose = {
      x: toMillimeters(position.x),
      y: toMillimeters(position.y),
      z: toMillimeters(position.z),
      rx: toDegrees(euler.x),
      ry: toDegrees(euler.y),
      rz: toDegrees(euler.z)
    }

    if (robotId) {
      setTCPPoseForRobot(robotId, nextTcpPose)
    } else if (robot === previewRobotRef.current) {
      setTCPPose(nextTcpPose)
    }

    const currentSelectedRobotId = useRobotStore.getState().selectedRobotId
    const activeRobot = currentSelectedRobotId
      ? robotRefs.current.get(currentSelectedRobotId)
      : robotsRef.current.length === 0
        ? previewRobotRef.current
        : null

    if (robot === activeRobot && dummyTarget && !transformControlsRef.current?.dragging) {
      const wristWorldPosition = new THREE.Vector3()
      const wristWorldQuaternion = new THREE.Quaternion()

      wristLink.getWorldPosition(wristWorldPosition)
      wristLink.getWorldQuaternion(wristWorldQuaternion)

      dummyTarget.position.copy(wristWorldPosition)
      dummyTarget.quaternion.copy(wristWorldQuaternion)
      dummyTarget.updateMatrixWorld(true)
    }
  }
  return (
    <div ref={containerRef} className="relative h-full w-full min-h-0 min-w-0 overflow-hidden">
      {/* Dynamic measurement label */}
      <div
        id="measure-label"
        className="absolute bg-[#1e1e24]/95 border border-blue-500/50 text-[10px] text-white px-2 py-1 rounded shadow-md pointer-events-none font-mono font-bold z-20 flex items-center gap-1.5"
        style={{ display: 'none', transform: 'translate(-50%, -50%)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping"></span>
        <span id="measure-text">0 mm</span>
      </div>

      {/* Dynamic self-measurement label */}
      <div
        id="self-measure-label"
        className="absolute bg-[#1e1e24]/95 border border-amber-500/50 text-[10px] text-white px-2 py-1 rounded shadow-md pointer-events-none font-mono font-bold z-20 flex items-center gap-1.5"
        style={{ display: 'none', transform: 'translate(-50%, -50%)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>
        <span id="self-measure-text">0 mm</span>
      </div>

      {/* Collision Warning Overlay */}
      {collisionWarning && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-rose-600/95 text-white px-4 py-1.5 rounded-full shadow-lg border border-rose-500 animate-pulse">
          <ShieldAlert size={14} />
          <span className="text-[10px] font-bold uppercase tracking-wider">
            Cảnh báo: Phát hiện va chạm!
          </span>
        </div>
      )}

      {/* Active backend robot info */}
      {selectedRobot && (
        <div className="absolute top-4 left-4 z-10 bg-[#141720]/90 border border-[#343849] text-slate-200 px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm pointer-events-none min-w-[220px]">
          <div className="text-[10px] uppercase tracking-wider text-blue-300 mb-1">
            Active Robot
          </div>
          <div className="text-sm font-semibold text-white truncate">{selectedRobot.name}</div>
          <div className="text-[11px] text-slate-400 truncate">{selectedRobot.model}</div>

          {selectedRobotSceneBinding && (
            <div className="mt-2 grid grid-cols-4 gap-1 text-[10px] text-slate-300">
              <div>
                <span className="block text-slate-500">X</span>
                {selectedRobotSceneBinding.baseX}
              </div>
              <div>
                <span className="block text-slate-500">Y</span>
                {selectedRobotSceneBinding.baseY}
              </div>
              <div>
                <span className="block text-slate-500">Z</span>
                {selectedRobotSceneBinding.baseZ}
              </div>
              <div>
                <span className="block text-slate-500">Yaw</span>
                {selectedRobotSceneBinding.baseYaw}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Helper floating shortcuts hint */}
      <div className="absolute top-4 right-4 z-10 bg-[#141720]/85 border border-[#343849] text-slate-400 p-2.5 rounded-lg shadow-lg backdrop-blur-sm max-w-[190px] pointer-events-none flex items-start gap-1.5 transition">
        <HelpCircle size={13} className="text-blue-400 shrink-0 mt-0.5" />
        <div className="text-[9px] space-y-1">
          <span className="font-bold text-white block">Phím tắt:</span>
          <div>
            <span className="font-semibold text-slate-300">W/A/S/D</span> - Di chuyển Camera
          </div>
          {selectedObjectId && (
            <div className="pt-1.5 border-t border-white/5 space-y-0.5 mt-1">
              <div>
                <span className="font-semibold text-slate-300">1</span> - Dịch chuyển
              </div>
              <div>
                <span className="font-semibold text-slate-300">2</span> - Xoay
              </div>
              <div>
                <span className="font-semibold text-slate-300">3</span> - Co giãn
              </div>
            </div>
          )}
        </div>
      </div>

      {isRobotPlacementMode && selectedRobot && (
        <div className="absolute bottom-4 left-4 z-10 max-w-xs rounded-lg border border-emerald-500/20 bg-[#141720]/90 px-3.5 py-2.5 text-slate-200 shadow-lg backdrop-blur-sm pointer-events-none">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
            CHẾ ĐỘ SẮP XẾP ROBOT
          </div>
          <p className="text-[10px] leading-normal text-slate-400">
            Di chuyển robot trên mặt sàn hoặc xoay hướng Yaw. Vị trí sẽ cập nhật vào panel bên trái,
            sau đó bấm Lưu để ghi vào Backend.
          </p>
        </div>
      )}

      {/* IK Mode Instructions */}
      {isIKMode && (
        <div className="absolute bottom-4 left-4 z-10 bg-[#141720]/90 border border-emerald-500/20 text-slate-200 px-3.5 py-2.5 rounded-lg shadow-lg backdrop-blur-sm max-w-xs pointer-events-none">
          <div className="flex items-center gap-1.5 text-emerald-400 font-semibold text-[10px] mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
            CHẾ ĐỘ CARTESIAN (IK)
          </div>
          <p className="text-[10px] text-slate-400 leading-normal">
            Kéo mũi tên 3D (Gizmo) hoặc quả cầu ở đầu gắp robot để điều khiển cánh tay.
          </p>
        </div>
      )}
    </div>
  )
}
