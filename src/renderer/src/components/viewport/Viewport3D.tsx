import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBB } from 'three/examples/jsm/math/OBB.js'
import { useRobotStore } from '../../store/robotStore'
import { useSceneStore } from '../../store/sceneStore'
import { solveIK } from '../../engine/robot/ikSolver'
import { ShieldAlert, HelpCircle, CircleAlert } from 'lucide-react'

import {
  getRobotRuntimeConfig,
  registerMoveLPlannerForRobot,
  registerMoveLRunner,
  registerMoveLRunnerForRobot
} from '../../services/robotMotionRuntime'
import { createViewportPerformanceMonitor } from '../../services/viewportPerformanceMonitor'
import { buildCollisionAlertPresentation } from '../../services/collision/collisionPresentation'
import { CollisionEngine } from '../../services/collision/collisionEngine'
import { CollisionScheduler } from '../../services/collision/collisionScheduler'
import { FAIRINO_FR5_COLLISION_POLICY } from '../../services/collision/collisionTypes'
import type { MoveLRunOptions, PreparedMoveLTrajectory } from '../../services/robotMotionRuntime'
import { throwIfCommandCancelled } from '../../services/commandExecutionRuntime'
import { runScheduledJointTrajectory } from '../../services/factoryMotionScheduler'
import { loadUrdfRobotWhenAssetsReady } from '../../services/urdfRobotLoader'
import { CartesianTraceRecorder } from '../../services/cartesianTraceRecorder'
import {
  hasCartesianTraceWristInput,
  isCartesianTraceControlKey,
  resolveCartesianTraceInput
} from '../../services/cartesianTraceInput'
import type { CartesianTraceSpeedMode } from '../../services/cartesianTraceInput'
import {
  clearRobotSafetyContact,
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
import type { CartesianTraceSample, CartesianTraceSnapshot } from '../../types/cartesianTrace.types'

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
const PREVIEW_COLLISION_ROBOT_ID = '__viewport_preview_robot__'
const COLLISION_SCHEDULER_INTERVAL_MS = 1000 / 15
const MEASUREMENT_SCHEDULER_INTERVAL_MS = 100
const TRACE_WRIST_JOINT_LIMITS_DEGREES = [
  { min: -265, max: 85 },
  { min: -175, max: 175 },
  { min: -175, max: 175 }
] as const
const LINK_LOCAL_BOX_CACHE = new WeakMap<THREE.Object3D, THREE.Box3 | null>()

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
  material: THREE.Material
  originalColor: THREE.Color | null
  originalEmissive: THREE.Color | null
  originalEmissiveIntensity: number | null
}

type RobotSafetyVisualState = 'normal' | 'proximity' | 'fault'
type CollisionReadinessStatus = 'loading' | 'ready' | 'error'

interface CollisionReadinessState {
  status: CollisionReadinessStatus
  robotCount: number
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

function createWarningCircle(color: number): THREE.Mesh {
  const outerRadius = FAIRINO_FR5_COLLISION_POLICY.thresholds.robotApproachZoneRadiusMeters
  const geometry = new THREE.RingGeometry(Math.max(0.01, outerRadius - 0.06), outerRadius, 64)
  const material = new THREE.MeshBasicMaterial({
    color: color,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.6,
    depthWrite: false
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.rotation.x = -Math.PI / 2
  return mesh
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

export interface SafetyVisualHelper {
  warningCircle?: THREE.Mesh
}

export default function Viewport3D(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const robotRef = useRef<FairinoRobotObject | null>(null)
  const robotRefs = useRef<Map<string, FairinoRobotObject>>(new Map())
  const collisionEngineRef = useRef<CollisionEngine | null>(null)
  const collisionSchedulerRef = useRef<CollisionScheduler | null>(null)
  const requestCollisionPrewarmRef = useRef<() => void>(() => undefined)
  const isTransformDraggingRef = useRef(false)
  const sceneGenerationRef = useRef(0)
  const robotLoadGenerationByIdRef = useRef<Map<string, number>>(new Map())
  const objectLoadGenerationByIdRef = useRef<Map<string, number>>(new Map())
  const robotMaterialSnapshotsByRobotIdRef = useRef<Map<string, RobotMaterialSnapshot[]>>(new Map())
  const robotSafetyVisualStateByRobotIdRef = useRef<Map<string, RobotSafetyVisualState>>(new Map())
  const safetyHelpersRef = useRef<Map<string, SafetyVisualHelper>>(new Map())
  const moveLRunnerUnregisterByRobotIdRef = useRef<Map<string, () => void>>(new Map())
  const previewRobotRef = useRef<FairinoRobotObject | null>(null)
  const previewRobotLoadingRef = useRef(false)
  const previewRobotLoadGenerationRef = useRef(0)
  const loadingRobotIdsRef = useRef<Set<string>>(new Set())
  const loadingObjectIdsRef = useRef<Set<string>>(new Set())
  const collisionLoadErrorRef = useRef(false)
  const robotsRef = useRef<RobotInstance[]>([])
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const transformControlsRef = useRef<TransformControls | null>(null)
  const dummyTargetRef = useRef<THREE.Object3D | null>(null)
  const traceHandleRef = useRef<THREE.Group | null>(null)
  const boxHelperRef = useRef<THREE.BoxHelper | null>(null)
  const measureLineRef = useRef<THREE.Line | null>(null)
  const selfMeasureLineRef = useRef<THREE.Line | null>(null)
  const hitboxHelpersRef = useRef<THREE.LineSegments[]>([])
  // Camera and Cartesian Trace must never share a key buffer. Otherwise a transient
  // robot/runtime state can leak W/A/S/D into camera navigation while Trace owns them.
  const keysPressedRef = useRef<Set<string>>(new Set())
  const traceKeysPressedRef = useRef<Set<string>>(new Set())
  const cartesianTraceRecorderRef = useRef(new CartesianTraceRecorder())
  const cancelCartesianTraceRef = useRef<(restoreStartPose: boolean) => void>(() => undefined)
  const factoryCameraStateRef = useRef<{
    position: THREE.Vector3
    target: THREE.Vector3
    near: number
    far: number
  } | null>(null)
  const previousWorkspaceModeRef = useRef(useRobotStore.getState().workspaceMode)
  const lastTrainCameraFocusIdRef = useRef<string | null>(null)
  const cartesianTraceContextRef = useRef('')
  const [isRobotLoaded, setIsRobotLoaded] = useState(false)
  const [isTechnicalDetailsExpanded, setIsTechnicalDetailsExpanded] = useState(false)
  const [collisionReadiness, setCollisionReadiness] = useState<CollisionReadinessState>({
    status: 'loading',
    robotCount: 0
  })
  const [cartesianTraceUi, setCartesianTraceUi] = useState<CartesianTraceSnapshot>({
    status: 'idle',
    rawSampleCount: 0,
    durationMs: 0
  })
  const [cartesianTraceNotice, setCartesianTraceNotice] = useState('')
  const [cartesianTraceSpeedMode, setCartesianTraceSpeedMode] =
    useState<CartesianTraceSpeedMode>('normal')
  const [isCartesianTraceHelpExpanded, setIsCartesianTraceHelpExpanded] = useState(true)

  const updateCollisionReadiness = (status: CollisionReadinessStatus, robotCount = 0): void => {
    setCollisionReadiness((current) =>
      current.status === status && current.robotCount === robotCount
        ? current
        : { status, robotCount }
    )
  }

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
        if (
          (!isColorMaterial(material) && !isHighlightableMaterial(material)) ||
          snapshottedMaterials.has(material)
        ) {
          continue
        }
        snapshottedMaterials.add(material)

        snapshots.push({
          material,
          originalColor: isColorMaterial(material) ? material.color.clone() : null,
          originalEmissive: isHighlightableMaterial(material) ? material.emissive.clone() : null,
          originalEmissiveIntensity: isHighlightableMaterial(material)
            ? material.emissiveIntensity
            : null
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

    const helpers = safetyHelpersRef.current.get(robotId)
    if (helpers) {
      const scene = sceneRef.current
      if (scene) {
        if (helpers.warningCircle) {
          scene.remove(helpers.warningCircle)
          helpers.warningCircle.geometry.dispose()
          if (Array.isArray(helpers.warningCircle.material)) {
            helpers.warningCircle.material.forEach((m) => m.dispose())
          } else {
            helpers.warningCircle.material.dispose()
          }
        }
      }
      safetyHelpersRef.current.delete(robotId)
    }
  }

  function getRobotSafetyVisualState(robotId: string): RobotSafetyVisualState {
    const sceneState = useSceneStore.getState()
    const contactLevel = sceneState.robotContactsById[robotId]?.level
    if (contactLevel === 'collision') return 'fault'
    if (contactLevel === 'proximity') return 'proximity'

    return 'normal'
  }

  function applyRobotSafetyVisual(robotId: string, force = false): void {
    const snapshots = robotMaterialSnapshotsByRobotIdRef.current.get(robotId)
    if (!snapshots) return

    const nextState = getRobotSafetyVisualState(robotId)
    if (!force && robotSafetyVisualStateByRobotIdRef.current.get(robotId) === nextState) return

    const scene = sceneRef.current

    for (const snapshot of snapshots) {
      if (snapshot.originalColor && isColorMaterial(snapshot.material)) {
        snapshot.material.color.copy(snapshot.originalColor)
      }

      if (
        snapshot.originalEmissive &&
        snapshot.originalEmissiveIntensity !== null &&
        isHighlightableMaterial(snapshot.material)
      ) {
        snapshot.material.emissive.copy(snapshot.originalEmissive)
        snapshot.material.emissiveIntensity = snapshot.originalEmissiveIntensity
      }

      snapshot.material.needsUpdate = true
    }

    if (scene) {
      let helpers = safetyHelpersRef.current.get(robotId)
      const prevState = robotSafetyVisualStateByRobotIdRef.current.get(robotId)

      if (nextState === 'normal' || (helpers && prevState !== nextState)) {
        if (helpers) {
          if (helpers.warningCircle) {
            scene.remove(helpers.warningCircle)
            helpers.warningCircle.geometry.dispose()
            if (Array.isArray(helpers.warningCircle.material)) {
              helpers.warningCircle.material.forEach((m) => m.dispose())
            } else {
              helpers.warningCircle.material.dispose()
            }
          }
          safetyHelpersRef.current.delete(robotId)
          helpers = undefined
        }
      }

      if (nextState !== 'normal') {
        const isCollision = nextState === 'fault'
        const circleColor = isCollision ? 0xff1f1f : 0xf59e0b

        if (!helpers) {
          const warningCircle = createWarningCircle(circleColor)

          const robot =
            robotId === PREVIEW_COLLISION_ROBOT_ID
              ? previewRobotRef.current
              : robotRefs.current.get(robotId)
          if (robot) {
            warningCircle.position.copy(robot.position)
            warningCircle.position.y += 0.01
            scene.add(warningCircle)

            safetyHelpersRef.current.set(robotId, { warningCircle })
          }
        } else {
          const robot =
            robotId === PREVIEW_COLLISION_ROBOT_ID
              ? previewRobotRef.current
              : robotRefs.current.get(robotId)
          if (robot) {
            if (helpers.warningCircle) {
              helpers.warningCircle.visible = robot.visible
              helpers.warningCircle.position.copy(robot.position)
              helpers.warningCircle.position.y += 0.01
            }
          }
        }
      }
    }

    robotSafetyVisualStateByRobotIdRef.current.set(robotId, nextState)
  }

  // Track loaded 3D models: map objectId -> THREE.Object3D
  const loadedObjectsRef = useRef<Map<string, THREE.Object3D>>(new Map())

  // Cache the last user config JSON to block infinite store update loop
  const lastUserConfigRef = useRef<string>('')

  const setJointAngles = useRobotStore((state) => state.setJointAngles)
  const setJointAnglesForRobot = useRobotStore((state) => state.setJointAnglesForRobot)
  const setTCPPose = useRobotStore((state) => state.setTCPPose)
  const setTCPPoseForRobot = useRobotStore((state) => state.setTCPPoseForRobot)
  const isIKMode = useRobotStore((state) => state.isIKMode)
  const cartesianInteractionMode = useRobotStore((state) => state.cartesianInteractionMode)
  const isRobotPlacementMode = useRobotStore((state) => state.isRobotPlacementMode)
  const robotPlacementTransformMode = useRobotStore((state) => state.robotPlacementTransformMode)
  const isPlaying = useRobotStore((state) => {
    const robotId = state.selectedRobotId

    return robotId ? (state.robotExecutionById[robotId]?.isPlaying ?? false) : state.isPlaying
  })
  const selectedJointName = useRobotStore((state) => state.selectedJointName)
  const steps = useRobotStore((state) => state.steps)
  const robots = useRobotStore((state) => state.robots)
  const language = useRobotStore((state) => state.language)
  const selectedRobotId = useRobotStore((state) => state.selectedRobotId)
  const workspaceMode = useRobotStore((state) => state.workspaceMode)
  const selectedRobot = robots.find((robot) => robot.id === selectedRobotId) ?? null
  const selectedRobotSceneBinding = selectedRobot?.sceneBinding ?? null

  const objects = useSceneStore((state) => state.objects)
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId)
  const robotFaultsById = useSceneStore((state) => state.robotFaultsById)
  const robotContactsById = useSceneStore((state) => state.robotContactsById)
  const collisionAlert = useMemo(
    () =>
      buildCollisionAlertPresentation(
        robots.map((robot) => ({ id: robot.id, name: robot.name })),
        robotContactsById,
        robotFaultsById,
        language
      ),
    [language, robotContactsById, robotFaultsById, robots]
  )

  const getTechnicalInfoSummary = (): string => {
    const sceneState = useSceneStore.getState()
    const lines: string[] = []

    for (const [id, contact] of Object.entries(sceneState.robotContactsById)) {
      lines.push(`[Contact] Robot: ${id}`)
      lines.push(`  Level: ${contact.level}`)
      lines.push(`  Kind: ${contact.kind}`)
      if (contact.counterpartRobotIds.length > 0) {
        lines.push(`  Counterparts: ${contact.counterpartRobotIds.join(', ')}`)
      }
      if (contact.objectIds.length > 0) {
        lines.push(`  Objects: ${contact.objectIds.join(', ')}`)
      }
      if (contact.message) {
        lines.push(`  Message: ${contact.message}`)
      }
    }

    for (const [id, fault] of Object.entries(sceneState.robotFaultsById)) {
      if (fault.active) {
        lines.push(`[Fault] Robot: ${id}`)
        lines.push(`  Kind: ${fault.kind}`)
        lines.push(`  Code: ${fault.code}`)
        lines.push(`  Message: ${fault.message}`)
      }
    }

    return (
      lines.join('\n') ||
      (language === 'vi' ? 'Không có chi tiết kỹ thuật' : 'No technical details available')
    )
  }

  useEffect(() => {
    if (!collisionAlert) {
      setIsTechnicalDetailsExpanded(false)
    }
  }, [collisionAlert])

  // Sync robots to ref for async loader check
  useEffect(() => {
    robotsRef.current = robots
  }, [robots])

  useEffect(() => {
    const robot = robotRef.current

    if (!robot || !isRobotLoaded) {
      return
    }

    // Train uses a local, centered presentation transform. Keep the persisted Factory binding
    // untouched so switching back restores the exact production layout.
    applyRobotSceneBinding(robot, workspaceMode === 'train' ? null : selectedRobotSceneBinding)
    collisionSchedulerRef.current?.requestImmediateTick()
  }, [
    isRobotLoaded,
    selectedRobotId,
    selectedRobotSceneBinding,
    selectedRobotSceneBinding?.baseX,
    selectedRobotSceneBinding?.baseY,
    selectedRobotSceneBinding?.baseZ,
    selectedRobotSceneBinding?.baseYaw,
    workspaceMode
  ])

  useEffect(() => {
    for (const robotId of robotRefs.current.keys()) {
      applyRobotSafetyVisual(robotId)
    }
    if (previewRobotRef.current) applyRobotSafetyVisual(PREVIEW_COLLISION_ROBOT_ID)

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
            : typeof preparedTrajectory.durationMs === 'number' &&
                Number.isFinite(preparedTrajectory.durationMs) &&
                preparedTrajectory.durationMs > 0
              ? preparedTrajectory.durationMs
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
    let localBox = LINK_LOCAL_BOX_CACHE.get(linkObj)
    if (localBox === undefined) {
      const invMatrix = new THREE.Matrix4().copy(linkObj.matrixWorld).invert()
      const computedLocalBox = new THREE.Box3()
      let hasMesh = false

      // Link geometry is rigid in its own frame. Cache this DFS result; joint/base motion only
      // changes matrixWorld and must not traverse meshes or recompute geometry bounds again.
      const collectMeshes = (node: THREE.Object3D): void => {
        if (node !== linkObj && allLinkObjs.has(node)) return

        if (node instanceof THREE.Mesh && node.geometry) {
          const mesh = node
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
          if (mesh.geometry.boundingBox) {
            const childRelMat = new THREE.Matrix4().multiplyMatrices(invMatrix, mesh.matrixWorld)
            const meshLocalBox = mesh.geometry.boundingBox.clone().applyMatrix4(childRelMat)
            computedLocalBox.union(meshLocalBox)
            hasMesh = true
          }
        }

        for (const child of node.children) collectMeshes(child)
      }

      collectMeshes(linkObj)
      localBox = hasMesh && !computedLocalBox.isEmpty() ? computedLocalBox : null
      LINK_LOCAL_BOX_CACHE.set(linkObj, localBox)
    }

    if (!localBox) return null

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
    const cartesianTraceRecorder = cartesianTraceRecorderRef.current
    const sceneGeneration = sceneGenerationRef.current + 1
    sceneGenerationRef.current = sceneGeneration
    const width = Math.max(1, container.clientWidth)
    const height = Math.max(1, container.clientHeight)

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#141417') // Dark industrial bg
    sceneRef.current = scene

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
    camera.position.set(1.5, 1.5, 1.5)
    cameraRef.current = camera

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

    // Freehand Cartesian handle. This is intentionally independent from TransformControls:
    // TransformControls remains the point-positioning tool, while this handle owns trace input.
    const traceHandle = new THREE.Group()
    traceHandle.name = 'cartesian_trace_handle'

    const traceCenter = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 20, 20),
      new THREE.MeshBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.72,
        depthTest: false
      })
    )
    traceCenter.name = 'cartesian_trace_handle_center'
    traceHandle.add(traceCenter)

    const traceRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.06, 0.006, 10, 32),
      new THREE.MeshBasicMaterial({
        color: 0xa5f3fc,
        transparent: true,
        opacity: 0.9,
        depthTest: false
      })
    )
    traceRing.name = 'cartesian_trace_handle_ring'
    traceHandle.add(traceRing)

    const traceAxes: Array<[THREE.Vector3, number]> = [
      [new THREE.Vector3(1, 0, 0), 0xef4444],
      [new THREE.Vector3(0, 1, 0), 0x22c55e],
      [new THREE.Vector3(0, 0, 1), 0x3b82f6]
    ]
    for (const [direction, color] of traceAxes) {
      const arrow = new THREE.ArrowHelper(direction, new THREE.Vector3(), 0.16, color, 0.045, 0.025)
      arrow.name = 'cartesian_trace_handle_axis'
      traceHandle.add(arrow)
    }

    traceHandle.traverse((child) => {
      child.renderOrder = 100
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        for (const material of materials) {
          material.depthTest = false
          material.depthWrite = false
          material.transparent = true
        }
      }
    })
    traceHandle.visible = false
    dummyTarget.add(traceHandle)
    traceHandleRef.current = traceHandle

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
      const isDragging = Boolean(event.value)
      isTransformDraggingRef.current = isDragging
      controls.enabled = !isDragging

      if (isDragging) {
        collisionSchedulerRef.current?.requestImmediateTick()
      } else {
        syncPlacementRobotSceneBinding()
        collisionSchedulerRef.current?.requestImmediateTick()
        requestCollisionPrewarmRef.current()
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
      const activeObject = transformControls.object
      const placementRobot = activeRobotId ? robotRefs.current.get(activeRobotId) : null
      if (robotState.isRobotPlacementMode && placementRobot && activeObject === placementRobot) {
        // Keep placement transient in Three.js while dragging. Committing Zustand here used to
        // rerender the entire Factory UI and restart collision scheduling for every pointer event.
        placementRobot.updateMatrixWorld(true)
        return
      }

      const robot = robotRef.current
      if (!robot) return

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

    const isCartesianTraceModeActive = (): boolean => {
      const state = useRobotStore.getState()

      return (
        state.workspaceMode === 'train' &&
        state.isIKMode &&
        state.cartesianInteractionMode === 'trace'
      )
    }

    const isCartesianTraceInputEnabled = (): boolean => {
      const state = useRobotStore.getState()
      const activeRobotId = state.selectedRobotId
      const playing = activeRobotId
        ? (state.robotExecutionById[activeRobotId]?.isPlaying ?? false)
        : state.isPlaying

      return isCartesianTraceModeActive() && !playing
    }

    const updateTraceSpeedUi = (): void => {
      setCartesianTraceSpeedMode(resolveCartesianTraceInput(traceKeysPressedRef.current).speedMode)
    }

    // Keyboard shortcuts listener for camera, trace wrist control and Gizmo transform modes.
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Ignore when typing in input fields
      const activeElement = document.activeElement
      const activeTag = activeElement?.tagName
      if (
        activeTag === 'INPUT' ||
        activeTag === 'TEXTAREA' ||
        activeTag === 'SELECT' ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)
      ) {
        return
      }

      const key = event.key.toLowerCase()
      if (key === 'escape') {
        cancelCartesianTraceRef.current(true)
        return
      }

      // Trace owns these keys for its whole UI mode, even while the robot is loading or
      // playback temporarily blocks motion. Never let them fall through to camera input.
      if (isCartesianTraceModeActive() && isCartesianTraceControlKey(key)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        traceKeysPressedRef.current.add(key)
        keysPressedRef.current.delete(key)
        updateTraceSpeedUi()
        return
      }

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
      if (isCartesianTraceControlKey(key)) {
        traceKeysPressedRef.current.delete(key)
        // Also clear a camera key that may have been held before switching into Trace.
        keysPressedRef.current.delete(key)
        updateTraceSpeedUi()
        if (isCartesianTraceModeActive()) {
          event.preventDefault()
          event.stopImmediatePropagation()
        }
        return
      }

      if (['w', 'a', 's', 'd'].includes(key)) {
        keysPressedRef.current.delete(key)
      }
    }

    const handleWindowBlur = (): void => {
      keysPressedRef.current.clear()
      traceKeysPressedRef.current.clear()
      setCartesianTraceSpeedMode('normal')
    }

    // Capture phase gives Trace priority over any application-level camera shortcut.
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', handleWindowBlur)
    // Click to select joints or imported 3D objects (Raycasting)
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()

    let tracePointerId: number | null = null
    let traceRobot: FairinoRobotObject | null = null
    let traceRobotId: string | null = null
    let traceCurrentAngles: JointAngles | null = null
    let traceStartedAtMs = 0
    let traceLastMotionUpdateMs = 0
    let traceLastUiUpdateMs = 0
    let traceLastKeyboardUpdateMs = 0
    let traceKeyboardWasActive = false
    const traceDragPlane = new THREE.Plane()
    const tracePointerStart = new THREE.Vector3()
    const traceWristStart = new THREE.Vector3()
    const traceWristQuaternion = new THREE.Quaternion()
    const traceIntersection = new THREE.Vector3()
    const tracePlaneNormal = new THREE.Vector3()
    const tracePointerDelta = new THREE.Vector3()
    const traceTargetWorldPosition = new THREE.Vector3()
    const traceTargetWorldMatrix = new THREE.Matrix4()
    const traceBaseMatrixInverse = new THREE.Matrix4()
    const traceRelativeMatrix = new THREE.Matrix4()
    const traceTargetPosition = new THREE.Vector3()
    const traceTargetQuaternion = new THREE.Quaternion()
    const traceTargetScale = new THREE.Vector3()
    const traceWristLocalPosition = new THREE.Vector3()
    const traceUnitScale = new THREE.Vector3(1, 1, 1)

    const updatePointerCoordinates = (event: PointerEvent): void => {
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    }

    const createTraceSample = (
      robot: FairinoRobotObject,
      angles: JointAngles,
      elapsedMs: number
    ): CartesianTraceSample | null => {
      const tcpPose = getRobotTcpPose(robot)
      return tcpPose
        ? {
            elapsedMs: Math.max(0, Math.round(elapsedMs)),
            tcpPose,
            jointAngles: [...angles] as JointAngles
          }
        : null
    }

    const clearTracePointerCapture = (): void => {
      if (tracePointerId !== null && renderer.domElement.hasPointerCapture(tracePointerId)) {
        renderer.domElement.releasePointerCapture(tracePointerId)
      }
      tracePointerId = null
      controls.enabled = true
      isTransformDraggingRef.current = false
    }

    const pauseCartesianTrace = (): CartesianTraceSnapshot => {
      const recorder = cartesianTraceRecorderRef.current
      if (!traceRobot || !traceCurrentAngles) return recorder.getSnapshot()

      const finalSample = createTraceSample(
        traceRobot,
        traceCurrentAngles,
        performance.now() - traceStartedAtMs
      )
      const snapshot = recorder.stop(finalSample ?? undefined)
      const robotState = useRobotStore.getState()
      if (traceRobotId) {
        robotState.setJointAnglesForRobot(traceRobotId, traceCurrentAngles)
      } else {
        robotState.setJointAngles(traceCurrentAngles)
      }

      setCartesianTraceUi(snapshot)
      setCartesianTraceNotice(
        snapshot.status === 'ready'
          ? robotState.language === 'vi'
            ? 'Đã tạm dừng. Kéo tiếp hoặc dùng phím để nối quỹ đạo; nhấp phải để lưu; Esc để hủy.'
            : 'Paused. Drag or use the wrist keys to continue; right-click to save; Esc to cancel.'
          : robotState.language === 'vi'
            ? 'Quỹ đạo quá ngắn, chưa có điểm để lưu.'
            : 'The path is too short to save.'
      )
      collisionSchedulerRef.current?.requestImmediateTick()
      return snapshot
    }

    const ensureTraceSessionForKeyboard = (now: number): boolean => {
      if (!isCartesianTraceInputEnabled()) return false

      const robotState = useRobotStore.getState()
      const robot = robotRef.current
      if (!robot?.links['wrist3_link']) return false

      const activeRobotId = robotState.selectedRobotId
      if (traceRobot !== robot || !traceCurrentAngles) {
        const currentAngles = activeRobotId
          ? (robotState.jointAnglesByRobotId[activeRobotId] ?? robotState.jointAngles)
          : robotState.jointAngles
        traceRobot = robot
        traceRobotId = activeRobotId
        traceCurrentAngles = [...currentAngles]
      }

      const recorder = cartesianTraceRecorderRef.current
      const snapshot = recorder.getSnapshot()
      if (snapshot.status === 'idle') {
        const firstSample = createTraceSample(robot, traceCurrentAngles, 0)
        if (!firstSample) return false
        recorder.start(firstSample)
        traceStartedAtMs = now
        setCartesianTraceUi(recorder.getSnapshot())
        setCartesianTraceNotice('')
      } else if (snapshot.status === 'ready') {
        if (!recorder.resume()) return false
        traceStartedAtMs = now - snapshot.durationMs
        setCartesianTraceUi(recorder.getSnapshot())
        setCartesianTraceNotice('')
      }

      return true
    }

    const updateTraceWristKeyboard = (frameTimestampMs: number): void => {
      const input = resolveCartesianTraceInput(traceKeysPressedRef.current)
      const hasWristInput = hasCartesianTraceWristInput(input)

      if (!isCartesianTraceInputEnabled() || !hasWristInput) {
        traceLastKeyboardUpdateMs = 0
        if (traceKeyboardWasActive && tracePointerId === null) pauseCartesianTrace()
        traceKeyboardWasActive = false
        return
      }

      traceKeyboardWasActive = true
      if (!ensureTraceSessionForKeyboard(frameTimestampMs) || !traceRobot || !traceCurrentAngles) {
        return
      }

      if (traceLastKeyboardUpdateMs <= 0) {
        traceLastKeyboardUpdateMs = frameTimestampMs
        return
      }

      // A time-based angular velocity is stable across FPS changes and ignores OS key repeat.
      const deltaSeconds = Math.min(0.05, (frameTimestampMs - traceLastKeyboardUpdateMs) / 1000)
      traceLastKeyboardUpdateMs = frameTimestampMs
      if (deltaSeconds <= 0) return

      const nextAngles = [...traceCurrentAngles] as JointAngles
      const directions = [input.j4Direction, input.j5Direction, input.j6Direction]
      let changed = false
      for (let wristIndex = 0; wristIndex < directions.length; wristIndex += 1) {
        const direction = directions[wristIndex]
        if (direction === 0) continue

        const jointIndex = wristIndex + 3
        const limit = TRACE_WRIST_JOINT_LIMITS_DEGREES[wristIndex]
        const nextValue = THREE.MathUtils.clamp(
          nextAngles[jointIndex] + direction * input.wristDegreesPerSecond * deltaSeconds,
          limit.min,
          limit.max
        )
        const roundedValue = Math.round(nextValue * 10) / 10
        if (roundedValue !== nextAngles[jointIndex]) {
          nextAngles[jointIndex] = roundedValue
          changed = true
        }
      }
      if (!changed) return

      traceCurrentAngles = nextAngles
      applyRobotJointValues(traceCurrentAngles, traceRobot)

      const wristLink = traceRobot.links['wrist3_link']
      wristLink?.getWorldQuaternion(traceWristQuaternion)
      const dummyTarget = dummyTargetRef.current
      if (dummyTarget && wristLink) {
        wristLink.getWorldPosition(dummyTarget.position)
        wristLink.getWorldQuaternion(dummyTarget.quaternion)
        dummyTarget.updateMatrixWorld(true)
      }

      const sample = createTraceSample(
        traceRobot,
        traceCurrentAngles,
        frameTimestampMs - traceStartedAtMs
      )
      if (
        sample &&
        cartesianTraceRecorderRef.current.append(sample) &&
        frameTimestampMs - traceLastUiUpdateMs >= 200
      ) {
        traceLastUiUpdateMs = frameTimestampMs
        setCartesianTraceUi(cartesianTraceRecorderRef.current.getSnapshot())
      }
    }

    const cancelCartesianTrace = (restoreStartPose: boolean): void => {
      const startSample = cartesianTraceRecorderRef.current.cancel()

      if (restoreStartPose && startSample && traceRobot) {
        applyRobotJointValues(startSample.jointAngles, traceRobot)
        const robotState = useRobotStore.getState()
        if (traceRobotId) {
          robotState.setJointAnglesForRobot(traceRobotId, startSample.jointAngles)
        } else {
          robotState.setJointAngles(startSample.jointAngles)
        }
      }

      clearTracePointerCapture()
      traceRobot = null
      traceRobotId = null
      traceCurrentAngles = null
      traceKeyboardWasActive = false
      traceLastKeyboardUpdateMs = 0
      traceKeysPressedRef.current.clear()
      setCartesianTraceSpeedMode('normal')
      setCartesianTraceUi(cartesianTraceRecorderRef.current.getSnapshot())
      setCartesianTraceNotice('')
      collisionSchedulerRef.current?.requestImmediateTick()
    }
    cancelCartesianTraceRef.current = cancelCartesianTrace

    const onTracePointerDown = (event: PointerEvent): void => {
      const robotState = useRobotStore.getState()
      const activeRobotId = robotState.selectedRobotId
      const playing = activeRobotId
        ? (robotState.robotExecutionById[activeRobotId]?.isPlaying ?? false)
        : robotState.isPlaying

      if (
        event.button !== 0 ||
        robotState.workspaceMode !== 'train' ||
        !robotState.isIKMode ||
        robotState.cartesianInteractionMode !== 'trace' ||
        playing
      ) {
        return
      }

      const robot = robotRef.current
      const wristLink = robot?.links['wrist3_link']
      if (!robot || !wristLink) return

      updatePointerCoordinates(event)
      raycaster.setFromCamera(mouse, camera)
      const wristWasHit = raycaster.intersectObject(wristLink, true).length > 0
      const traceHandleWasHit = dummyTargetRef.current
        ? raycaster
            .intersectObject(dummyTargetRef.current, true)
            .some((intersection) => intersection.object instanceof THREE.Mesh)
        : false
      if (!wristWasHit && !traceHandleWasHit) return

      event.preventDefault()
      event.stopImmediatePropagation()

      wristLink.getWorldPosition(traceWristStart)
      wristLink.getWorldQuaternion(traceWristQuaternion)
      camera.getWorldDirection(tracePlaneNormal).normalize()
      traceDragPlane.setFromNormalAndCoplanarPoint(tracePlaneNormal, traceWristStart)
      if (!raycaster.ray.intersectPlane(traceDragPlane, tracePointerStart)) return
      traceTargetWorldPosition.copy(traceWristStart)

      const currentAngles =
        traceRobot === robot && traceCurrentAngles
          ? traceCurrentAngles
          : activeRobotId
            ? (robotState.jointAnglesByRobotId[activeRobotId] ?? robotState.jointAngles)
            : robotState.jointAngles
      const firstSample = createTraceSample(robot, currentAngles, 0)
      if (!firstSample) return

      const recorder = cartesianTraceRecorderRef.current
      const previousSnapshot = recorder.getSnapshot()
      const now = performance.now()

      tracePointerId = event.pointerId
      traceRobot = robot
      traceRobotId = activeRobotId
      traceCurrentAngles = [...currentAngles]
      // Paused time is deliberately excluded so playback timing represents only the
      // user's actual drawing motion. A resumed segment continues the existing draft.
      if (previousSnapshot.status !== 'recording') {
        traceStartedAtMs =
          now - (previousSnapshot.status === 'ready' ? previousSnapshot.durationMs : 0)
      }
      traceLastMotionUpdateMs = now
      traceLastUiUpdateMs = now
      if (previousSnapshot.status === 'idle') {
        recorder.start(firstSample)
      } else if (previousSnapshot.status === 'ready' && !recorder.resume()) {
        recorder.start(firstSample)
        traceStartedAtMs = now
      }
      setCartesianTraceUi(recorder.getSnapshot())
      setCartesianTraceNotice('')
      controls.enabled = false
      isTransformDraggingRef.current = true
      renderer.domElement.setPointerCapture(event.pointerId)
    }

    const onTracePointerMove = (event: PointerEvent): void => {
      if (event.pointerId !== tracePointerId || !traceRobot || !traceCurrentAngles) {
        return
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      const now = performance.now()
      // Numerical IK is the expensive part of freehand control. Thirty solutions per second are
      // sufficient for pointer input and halve the main-thread work compared with raw 60 Hz events.
      if (now - traceLastMotionUpdateMs < 33) return
      traceLastMotionUpdateMs = now
      updatePointerCoordinates(event)
      raycaster.setFromCamera(mouse, camera)
      if (!raycaster.ray.intersectPlane(traceDragPlane, traceIntersection)) return

      const wristLink = traceRobot.links['wrist3_link']
      const baseLink = traceRobot.links['base_link']
      if (!wristLink || !baseLink) return

      tracePointerDelta.subVectors(traceIntersection, tracePointerStart)
      tracePointerStart.copy(traceIntersection)
      const traceInput = resolveCartesianTraceInput(traceKeysPressedRef.current)
      traceTargetWorldPosition.addScaledVector(tracePointerDelta, traceInput.pointerGain)
      traceTargetWorldMatrix.compose(traceTargetWorldPosition, traceWristQuaternion, traceUnitScale)
      traceBaseMatrixInverse.copy(baseLink.matrixWorld).invert()
      traceRelativeMatrix.multiplyMatrices(traceBaseMatrixInverse, traceTargetWorldMatrix)
      traceRelativeMatrix.decompose(traceTargetPosition, traceTargetQuaternion, traceTargetScale)

      wristLink.getWorldPosition(traceWristLocalPosition)
      traceWristLocalPosition.applyMatrix4(traceBaseMatrixInverse)
      const targetDelta = traceTargetPosition.distanceTo(traceWristLocalPosition)
      if (targetDelta > 0.08) {
        traceTargetPosition
          .sub(traceWristLocalPosition)
          .normalize()
          .multiplyScalar(0.08)
          .add(traceWristLocalPosition)
      }

      const solvedAngles = solveIK(
        traceTargetPosition,
        traceTargetQuaternion,
        traceCurrentAngles,
        traceRobot,
        {
          maxIterations: 8,
          tolerancePositionMeters: 0.0015,
          toleranceRotationRadians: 0.006,
          maxStepDegrees: 10
        }
      )
      if (!solvedAngles) {
        const currentLanguage = useRobotStore.getState().language
        setCartesianTraceNotice(
          currentLanguage === 'vi'
            ? 'Không tìm được nghiệm IK tại vị trí này.'
            : 'No IK solution at this position.'
        )
        return
      }

      traceCurrentAngles = toJointAngles(solvedAngles)
      applyRobotJointValues(traceCurrentAngles, traceRobot)

      const dummyTarget = dummyTargetRef.current
      if (dummyTarget) {
        wristLink.getWorldPosition(dummyTarget.position)
        wristLink.getWorldQuaternion(dummyTarget.quaternion)
        dummyTarget.updateMatrixWorld(true)
      }

      const sample = createTraceSample(traceRobot, traceCurrentAngles, now - traceStartedAtMs)
      if (
        sample &&
        cartesianTraceRecorderRef.current.append(sample) &&
        now - traceLastUiUpdateMs >= 200
      ) {
        traceLastUiUpdateMs = now
        setCartesianTraceUi(cartesianTraceRecorderRef.current.getSnapshot())
      }
    }

    const finishCartesianTrace = (event: PointerEvent): void => {
      if (event.pointerId !== tracePointerId || !traceRobot || !traceCurrentAngles) {
        return
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      traceLastMotionUpdateMs = 0
      onTracePointerMove(event)
      clearTracePointerCapture()
      if (!hasCartesianTraceWristInput(resolveCartesianTraceInput(traceKeysPressedRef.current))) {
        pauseCartesianTrace()
      }
    }

    const onTracePointerCancel = (event: PointerEvent): void => {
      if (event.pointerId === tracePointerId) cancelCartesianTrace(true)
    }

    const onTraceContextMenu = (event: MouseEvent): void => {
      const robotState = useRobotStore.getState()
      if (
        robotState.workspaceMode !== 'train' ||
        !robotState.isIKMode ||
        robotState.cartesianInteractionMode !== 'trace'
      ) {
        return
      }

      event.preventDefault()
      const recorder = cartesianTraceRecorderRef.current
      let snapshot = recorder.getSnapshot()
      // keyup and contextmenu may happen before the next animation frame. Finalize the
      // keyboard segment synchronously so a right-click immediately after releasing a key
      // never gets ignored just because the recorder still reports `recording`.
      if (
        snapshot.status === 'recording' &&
        tracePointerId === null &&
        !hasCartesianTraceWristInput(resolveCartesianTraceInput(traceKeysPressedRef.current))
      ) {
        snapshot = pauseCartesianTrace()
      }
      if (snapshot.status !== 'ready') return

      const newSteps = recorder.buildSteps(robotState.steps)
      if (newSteps.length === 0) return
      robotState.addSteps(newSteps)
      recorder.cancel()
      traceRobot = null
      traceRobotId = null
      traceCurrentAngles = null
      traceKeyboardWasActive = false
      traceLastKeyboardUpdateMs = 0
      setCartesianTraceUi(recorder.getSnapshot())
      setCartesianTraceNotice(
        robotState.language === 'vi'
          ? `Đã lưu ${newSteps.length} bước chuyển động vào workflow.`
          : `Saved ${newSteps.length} motion steps to the workflow.`
      )
    }

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

    renderer.domElement.addEventListener('pointerdown', onTracePointerDown, true)
    renderer.domElement.addEventListener('pointermove', onTracePointerMove, true)
    renderer.domElement.addEventListener('pointerup', finishCartesianTrace, true)
    renderer.domElement.addEventListener('pointercancel', onTracePointerCancel, true)
    renderer.domElement.addEventListener('contextmenu', onTraceContextMenu, true)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)

    let lastMeasurementGeometrySignature: string | null = null

    const projectMeasurementLabel = (line: THREE.Line, label: HTMLElement | null): void => {
      if (!label || !containerRef.current || !line.visible) {
        if (label) label.style.display = 'none'
        return
      }

      const positions = line.geometry.getAttribute('position')
      if (!positions || positions.count < 2) {
        label.style.display = 'none'
        return
      }

      const midpoint = new THREE.Vector3(
        (positions.getX(0) + positions.getX(1)) * 0.5,
        (positions.getY(0) + positions.getY(1)) * 0.5,
        (positions.getZ(0) + positions.getZ(1)) * 0.5
      ).project(camera)
      label.style.left = `${(midpoint.x * 0.5 + 0.5) * containerRef.current.clientWidth}px`
      label.style.top = `${(-midpoint.y * 0.5 + 0.5) * containerRef.current.clientHeight}px`
      label.style.display = 'flex'
    }

    const createMeasurementGeometrySignature = (
      robot: FairinoRobotObject,
      sceneState: ReturnType<typeof useSceneStore.getState>,
      isDebug: boolean,
      unit: string,
      currentLanguage: string
    ): string => {
      const signature: Array<string | number> = [
        robot.uuid,
        isDebug ? 1 : 0,
        unit,
        currentLanguage,
        sceneState.selectedObjectId ?? ''
      ]

      for (const [linkName, link] of Object.entries(
        robot.links as Record<string, THREE.Object3D>
      ).sort(([leftName], [rightName]) => leftName.localeCompare(rightName))) {
        signature.push(linkName)
        for (const value of link.matrixWorld.elements) {
          signature.push(Math.round(value * 100_000))
        }
      }

      for (const objectId of [...loadedObjectsRef.current.keys()].sort()) {
        const sceneObject = sceneState.objects.find((object) => object.id === objectId)
        signature.push(
          objectId,
          sceneObject?.visible ? 1 : 0,
          sceneState.objectTransformRevisionById[objectId] ?? 0
        )
      }

      return signature.join('|')
    }

    // Measurement and hitbox geometry is cached by pose. Camera-only movement merely projects
    // the existing line endpoints again; it must not rebuild every link OBB and object Box3.
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

      const sceneState = useSceneStore.getState()
      const unit = useRobotStore.getState().lengthUnit
      const isDebug = sceneState.isDebugHitbox
      const currentLanguage = useRobotStore.getState().language
      const geometrySignature = createMeasurementGeometrySignature(
        robot,
        sceneState,
        isDebug,
        unit,
        currentLanguage
      )

      if (lastMeasurementGeometrySignature === geometrySignature) {
        projectMeasurementLabel(measureLine, labelEl)
        if (selfLabelEl) selfLabelEl.style.display = selfMeasureLine.visible ? 'flex' : 'none'
        return
      }
      lastMeasurementGeometrySignature = geometrySignature

      // 1. Gather active visible auxiliary objects (AABB is fine for non-articulated objects)
      const activeObjects: { id: string; name: string; box: THREE.Box3 }[] = []
      for (const [id, threeObj] of loadedObjectsRef.current.entries()) {
        const storeObj = sceneState.objects.find((o) => o.id === id)
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
      const selectedId = sceneState.selectedObjectId
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

          if (selfLabelEl && selfTextEl) {
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

    const collisionEngine = new CollisionEngine({
      getSnapshot: () => {
        const sceneState = useSceneStore.getState()
        const robotState = useRobotStore.getState()
        const currentWorkspaceMode = robotState.workspaceMode
        const sceneObjectsById = new Map(
          sceneState.objects.map((sceneObject) => [sceneObject.id, sceneObject])
        )
        const collisionRobots = Array.from(robotRefs.current.entries())
          .filter(([, robot]) => robot.visible)
          .map(([robotId, robot]) => ({
            robotId,
            object: robot,
            links: robot.links as Record<string, THREE.Object3D>,
            visible: robot.visible,
            monitoringMode:
              currentWorkspaceMode === 'train'
                ? ('training-preview' as const)
                : robotState.robotRuntimeById[robotId]?.isConnected ||
                    robotState.robotRuntimeById[robotId]?.isRunning
                  ? ('factory-active' as const)
                  : ('factory-static' as const)
          }))

        if (collisionRobots.length === 0 && previewRobotRef.current?.visible) {
          collisionRobots.push({
            robotId: PREVIEW_COLLISION_ROBOT_ID,
            object: previewRobotRef.current,
            links: previewRobotRef.current.links as Record<string, THREE.Object3D>,
            visible: true,
            monitoringMode: 'training-preview' as const
          })
        }

        return {
          robots: collisionRobots,
          obstacles: Array.from(loadedObjectsRef.current.entries()).map(([objectId, object]) => ({
            objectId,
            object,
            visible: sceneObjectsById.get(objectId)?.visible ?? false,
            transformRevision: sceneState.objectTransformRevisionById[objectId] ?? 0
          }))
        }
      },
      getRobotPolicy: () => FAIRINO_FR5_COLLISION_POLICY,
      onContactTransition: ({ robotId, monitoringMode, observation }) => {
        if (observation) {
          reportRobotSafetyContact(
            robotId,
            {
              level: observation.level,
              kind: observation.kind,
              counterpartRobotIds: observation.counterpartRobotIds,
              objectIds: observation.objectIds,
              message: observation.message
            },
            {
              triggerSafetyAction: monitoringMode === 'factory-active',
              forceSafetyAction: monitoringMode === 'factory-active'
            }
          )
          return
        }

        const currentContact = useSceneStore.getState().robotContactsById[robotId]
        if (
          currentContact &&
          ['ground', 'self', 'obstacle', 'robot'].includes(currentContact.kind)
        ) {
          // The engine emits this transition only after its clear hysteresis has confirmed that
          // the robot is safe again. Clear the direct collision latch atomically with the contact
          // so placement recovery never leaves an unreachable "waiting for reset" state.
          clearRobotSafetyContact(robotId, { resetResolvedCollisionFault: true })
        }
      }
    })
    collisionEngineRef.current = collisionEngine

    const collisionScheduler = new CollisionScheduler({
      intervalMs: COLLISION_SCHEDULER_INTERVAL_MS,
      tick: () => {
        const stageStartedAtMs = viewportPerformance.beginStage()
        const result = collisionEngine.tick()
        const storedContacts = useSceneStore.getState().robotContactsById
        for (const activeContact of collisionEngine.getActiveContacts()) {
          if (storedContacts[activeContact.robotId]) continue
          reportRobotSafetyContact(
            activeContact.robotId,
            {
              level: activeContact.observation.level,
              kind: activeContact.observation.kind,
              counterpartRobotIds: activeContact.observation.counterpartRobotIds,
              objectIds: activeContact.observation.objectIds,
              message: activeContact.observation.message
            },
            {
              // Reconciliation repairs presentation state only. The original transition remains
              // solely responsible for Factory stop actions, so program behavior is unchanged.
              triggerSafetyAction: false,
              forceSafetyAction: false
            }
          )
        }
        if (result.narrowPhaseRobotCount > 0 && collisionEngine.isExactGeometryReady()) {
          collisionLoadErrorRef.current = false
          updateCollisionReadiness('ready', result.narrowPhaseRobotCount)
        } else {
          updateCollisionReadiness(collisionLoadErrorRef.current ? 'error' : 'loading')
        }
        viewportPerformance.endStage('collision', stageStartedAtMs)
      },
      onError: (error) => {
        updateCollisionReadiness('error')
        console.error('[Viewport3D] Collision scheduler failed.', error)
      }
    })
    collisionSchedulerRef.current = collisionScheduler
    const measurementScheduler = new CollisionScheduler({
      intervalMs: MEASUREMENT_SCHEDULER_INTERVAL_MS,
      tick: () => {
        const stageStartedAtMs = viewportPerformance.beginStage()
        updateMeasurementAndHitboxes()
        viewportPerformance.endStage('measurement', stageStartedAtMs)
      },
      onError: (error) => console.error('[Viewport3D] Measurement scheduler failed.', error)
    })
    collisionScheduler.start()
    measurementScheduler.start()

    let collisionPrewarmIdleHandle: number | null = null
    let collisionPrewarmFallbackHandle: number | null = null
    const runCollisionPrewarm = (): void => {
      collisionPrewarmIdleHandle = null
      collisionPrewarmFallbackHandle = null
      // BVH construction is background work. Never let it compete with a user gesture; the
      // dragging-changed(false) handler schedules it again after interaction completes.
      if (isTransformDraggingRef.current) return
      if (!collisionEngine.prewarmExactGeometry(1)) {
        requestCollisionPrewarm()
        return
      }

      // The first exact scan must run as soon as all BVHs are ready; otherwise a static unsafe
      // startup pose would wait for an unrelated user action before producing a warning.
      collisionScheduler.requestImmediateTick()
    }
    const requestCollisionPrewarm = (): void => {
      if (collisionPrewarmIdleHandle !== null || collisionPrewarmFallbackHandle !== null) return
      if (typeof window.requestIdleCallback === 'function') {
        // A timeout prevents Chromium from starving collision preparation during a busy startup.
        collisionPrewarmIdleHandle = window.requestIdleCallback(runCollisionPrewarm, {
          timeout: 16
        })
      } else {
        collisionPrewarmFallbackHandle = window.setTimeout(runCollisionPrewarm, 16)
      }
    }
    requestCollisionPrewarmRef.current = requestCollisionPrewarm
    requestCollisionPrewarm()

    const unsubscribeRobotRuntime = useRobotStore.subscribe((state, previousState) => {
      const activeRobotAdded = Object.entries(state.robotRuntimeById).some(([robotId, runtime]) => {
        const wasActive = Boolean(
          previousState.robotRuntimeById[robotId]?.isConnected ||
          previousState.robotRuntimeById[robotId]?.isRunning
        )
        return (runtime.isConnected || runtime.isRunning) && !wasActive
      })
      if (activeRobotAdded) collisionScheduler.requestImmediateTick()
    })

    // Animation Loop: camera and drawing only. Collision/measurement have independent budgets.
    let animationFrameId: number
    // Real-time camera navigation via WASD keys on horizontal plane
    const updateWASDNavigation = (): void => {
      // Trace mode owns WASD for J4/J5. Camera navigation remains unchanged elsewhere.
      if (isCartesianTraceInputEnabled()) return

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

      updateTraceWristKeyboard(frameTimestampMs)
      updateWASDNavigation()

      if (safetyHelpersRef.current) {
        const time = frameTimestampMs * 0.003
        for (const [id, helpers] of safetyHelpersRef.current.entries()) {
          const robot =
            id === PREVIEW_COLLISION_ROBOT_ID ? previewRobotRef.current : robotRefs.current.get(id)
          if (robot && robot.visible) {
            if (helpers.warningCircle) {
              helpers.warningCircle.position.copy(robot.position)
              helpers.warningCircle.position.y += 0.01

              const pulse = Math.sin(time * 2.0) * 0.5 + 0.5
              helpers.warningCircle.scale.setScalar(1.0 + pulse * 0.15)
              if (!Array.isArray(helpers.warningCircle.material)) {
                helpers.warningCircle.material.opacity = 0.35 + pulse * 0.35
              }
            }
          }
        }
      }

      const stageStartedAtMs = viewportPerformance.beginStage()
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
    const loadedRobots = robotRefs.current
    const loadingRobotIds = loadingRobotIdsRef.current
    const loadedObjects = loadedObjectsRef.current
    const loadingObjectIds = loadingObjectIdsRef.current
    const safetyHelpers = safetyHelpersRef.current
    const pressedKeys = keysPressedRef.current
    const pressedTraceKeys = traceKeysPressedRef.current
    // Clean up
    return () => {
      const ownsCurrentScene =
        sceneRef.current === scene && sceneGenerationRef.current === sceneGeneration

      if (ownsCurrentScene) sceneGenerationRef.current += 1
      cancelAnimationFrame(animationFrameId)
      collisionScheduler.stop()
      if (collisionSchedulerRef.current === collisionScheduler) {
        collisionSchedulerRef.current = null
      }
      measurementScheduler.stop()
      if (collisionPrewarmIdleHandle !== null) {
        window.cancelIdleCallback(collisionPrewarmIdleHandle)
        collisionPrewarmIdleHandle = null
      }
      if (collisionPrewarmFallbackHandle !== null) {
        window.clearTimeout(collisionPrewarmFallbackHandle)
        collisionPrewarmFallbackHandle = null
      }
      if (requestCollisionPrewarmRef.current === requestCollisionPrewarm) {
        requestCollisionPrewarmRef.current = () => undefined
      }
      unsubscribeRobotRuntime()
      // StrictMode performs an internal setup -> cleanup -> setup cycle before async models load.
      // Avoid publishing a fake clear for that empty scene, but clear real contacts if a populated
      // scene is genuinely replaced (for example by hot reload or component unmount).
      collisionEngine.dispose({
        emitClearTransitions: loadedRobots.size > 0 || Boolean(previewRobotRef.current)
      })
      if (collisionEngineRef.current === collisionEngine) collisionEngineRef.current = null
      resizeObserver.disconnect()

      if (ownsCurrentScene) {
        previewRobotLoadGenerationRef.current += 1
        previewRobotLoadingRef.current = false
        loadingRobotIds.clear()
        loadingObjectIds.clear()

        for (const [robotId, robot] of loadedRobots) {
          scene.remove(robot)
          removeRobotMaterialCache(robotId)
          unregisterLoadedRobotMoveLRunner(robotId)
          disposeRobotObject(robot)
        }
        loadedRobots.clear()

        const previewRobot = previewRobotRef.current
        if (previewRobot) {
          scene.remove(previewRobot)
          removeRobotMaterialCache(PREVIEW_COLLISION_ROBOT_ID)
          disposeRobotObject(previewRobot)
        }
        previewRobotRef.current = null
        robotRef.current = null

        for (const object of loadedObjects.values()) {
          scene.remove(object)
          disposeRobotObject(object)
        }
        loadedObjects.clear()
        sceneRef.current = null
      }

      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', handleWindowBlur)
      pressedKeys.clear()
      pressedTraceKeys.clear()
      cartesianTraceRecorder.cancel()
      clearTracePointerCapture()
      cancelCartesianTraceRef.current = () => undefined
      renderer.domElement.removeEventListener('pointerdown', onTracePointerDown, true)
      renderer.domElement.removeEventListener('pointermove', onTracePointerMove, true)
      renderer.domElement.removeEventListener('pointerup', finishCartesianTrace, true)
      renderer.domElement.removeEventListener('pointercancel', onTracePointerCancel, true)
      renderer.domElement.removeEventListener('contextmenu', onTraceContextMenu, true)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      if (cameraRef.current === camera) cameraRef.current = null
      if (controlsRef.current === controls) controlsRef.current = null
      if (traceHandleRef.current === traceHandle) traceHandleRef.current = null
      renderer.dispose()
      transformControls.dispose()
      robotMaterialSnapshots.clear()
      robotSafetyVisualStates.clear()
      safetyHelpers.clear()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
    // This effect owns the Three.js scene lifecycle and must run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Synchronize 3D models in store with Three.js scene
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    const sceneGeneration = sceneGenerationRef.current
    const loadedMap = loadedObjectsRef.current
    const nextObjectIds = new Set(objects.map((object) => object.id))

    for (const loadingObjectId of Array.from(loadingObjectIdsRef.current)) {
      if (nextObjectIds.has(loadingObjectId)) continue
      objectLoadGenerationByIdRef.current.set(
        loadingObjectId,
        (objectLoadGenerationByIdRef.current.get(loadingObjectId) ?? 0) + 1
      )
      loadingObjectIdsRef.current.delete(loadingObjectId)
    }

    // 1. Load newly added objects
    objects.forEach((obj) => {
      if (!loadedMap.has(obj.id) && !loadingObjectIdsRef.current.has(obj.id)) {
        const objectLoadGeneration = (objectLoadGenerationByIdRef.current.get(obj.id) ?? 0) + 1
        objectLoadGenerationByIdRef.current.set(obj.id, objectLoadGeneration)
        loadingObjectIdsRef.current.add(obj.id)

        const getCurrentObject = (): (typeof objects)[number] | undefined =>
          useSceneStore.getState().objects.find((candidate) => candidate.id === obj.id)
        const loadIsCurrent = (): boolean =>
          sceneRef.current === scene &&
          sceneGenerationRef.current === sceneGeneration &&
          objectLoadGenerationByIdRef.current.get(obj.id) === objectLoadGeneration &&
          Boolean(getCurrentObject())
        const finishCurrentLoad = (): void => {
          if (objectLoadGenerationByIdRef.current.get(obj.id) === objectLoadGeneration) {
            loadingObjectIdsRef.current.delete(obj.id)
          }
        }

        if (obj.fileType === 'stl') {
          const stlLoader = new STLLoader()
          stlLoader.load(
            obj.url,
            (geometry) => {
              const currentObject = getCurrentObject()
              if (!loadIsCurrent() || !currentObject) {
                geometry.dispose()
                finishCurrentLoad()
                return
              }

              const material = new THREE.MeshStandardMaterial({
                color: 0x90caf9,
                roughness: 0.5,
                metalness: 0.2
              })
              const mesh = new THREE.Mesh(geometry, material)
              mesh.castShadow = true
              mesh.receiveShadow = true

              updateThreeObjTransform(mesh, currentObject.transform)
              mesh.visible = currentObject.visible

              scene.add(mesh)
              loadedMap.set(obj.id, mesh)
              finishCurrentLoad()
              updateSelection()
              collisionSchedulerRef.current?.requestImmediateTick()
            },
            undefined,
            (error) => {
              if (loadIsCurrent()) console.error('An error occurred loading STL:', error)
              finishCurrentLoad()
            }
          )
        } else {
          const gltfLoader = new GLTFLoader()
          gltfLoader.load(
            obj.url,
            (gltf) => {
              const currentObject = getCurrentObject()
              if (!loadIsCurrent() || !currentObject) {
                disposeRobotObject(gltf.scene)
                finishCurrentLoad()
                return
              }

              const model = gltf.scene
              model.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                  child.castShadow = true
                  child.receiveShadow = true
                }
              })

              updateThreeObjTransform(model, currentObject.transform)
              model.visible = currentObject.visible

              scene.add(model)
              loadedMap.set(obj.id, model)
              finishCurrentLoad()
              updateSelection()
              collisionSchedulerRef.current?.requestImmediateTick()
            },
            undefined,
            (error) => {
              if (loadIsCurrent()) console.error('An error occurred loading GLTF:', error)
              finishCurrentLoad()
            }
          )
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
          disposeRobotObject(threeObj)
        }
      }
    }

    updateSelection()
    collisionSchedulerRef.current?.requestImmediateTick()
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
    const traceHandle = traceHandleRef.current
    const robot = robotRef.current

    if (!transformControls || !dummyTarget) return

    if (!robot || isPlaying) {
      transformControls.detach()
      transformControls.getHelper().visible = false
      dummyTarget.visible = false
      if (traceHandle) traceHandle.visible = false
      highlightJointLink(null)
      return
    }

    const placementRobot = selectedRobotId ? robotRefs.current.get(selectedRobotId) : null

    if (isRobotPlacementMode && placementRobot) {
      dummyTarget.visible = false
      if (traceHandle) traceHandle.visible = false
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

    if (isIKMode && cartesianInteractionMode === 'trace') {
      highlightJointLink(null)
      transformControls.detach()
      transformControls.getHelper().visible = false

      const wristLink = robot.links['wrist3_link']
      if (wristLink && cartesianTraceUi.status !== 'recording') {
        wristLink.getWorldPosition(dummyTarget.position)
        wristLink.getWorldQuaternion(dummyTarget.quaternion)
        dummyTarget.updateMatrixWorld(true)
      }
      dummyTarget.visible = true
      if (traceHandle) traceHandle.visible = true
    } else if (isIKMode) {
      if (traceHandle) traceHandle.visible = false
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
      if (traceHandle) traceHandle.visible = false
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
      if (traceHandle) traceHandle.visible = false
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
      if (traceHandle) traceHandle.visible = false
      highlightJointLink(null)
      transformControls.detach()
      transformControls.getHelper().visible = false
    }
    // highlightJointLink reads stable refs and current stores; including it would rerun every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isIKMode,
    cartesianInteractionMode,
    cartesianTraceUi.status,
    isRobotPlacementMode,
    robotPlacementTransformMode,
    isRobotLoaded,
    isPlaying,
    selectedJointName,
    selectedObjectId,
    selectedRobotId
  ])

  useEffect(() => {
    const contextKey = `${workspaceMode}:${selectedRobotId ?? 'preview'}:${isIKMode}:${cartesianInteractionMode}:${isPlaying}`
    const traceIsAllowed =
      workspaceMode === 'train' && isIKMode && cartesianInteractionMode === 'trace' && !isPlaying

    if (
      !traceIsAllowed ||
      (cartesianTraceContextRef.current !== '' &&
        cartesianTraceContextRef.current !== contextKey &&
        cartesianTraceRecorderRef.current.getSnapshot().status !== 'idle')
    ) {
      cancelCartesianTraceRef.current(true)
    }
    cartesianTraceContextRef.current = contextKey
  }, [cartesianInteractionMode, isIKMode, isPlaying, selectedRobotId, workspaceMode])

  useEffect(() => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls) return

    const previousMode = previousWorkspaceModeRef.current

    if (workspaceMode === 'train') {
      if (previousMode !== 'train' && !factoryCameraStateRef.current) {
        factoryCameraStateRef.current = {
          position: camera.position.clone(),
          target: controls.target.clone(),
          near: camera.near,
          far: camera.far
        }
      }

      const activeRobot = selectedRobotId
        ? (robotRefs.current.get(selectedRobotId) ?? null)
        : robots.length === 0
          ? previewRobotRef.current
          : null
      const focusId =
        selectedRobotId ?? (activeRobot === previewRobotRef.current ? 'preview' : null)
      if (activeRobot && focusId && lastTrainCameraFocusIdRef.current !== focusId) {
        activeRobot.updateMatrixWorld(true)
        const bounds = new THREE.Box3().setFromObject(activeRobot)
        if (!bounds.isEmpty()) {
          const center = bounds.getCenter(new THREE.Vector3())
          const size = bounds.getSize(new THREE.Vector3())
          const viewDirection = camera.position.clone().sub(controls.target)
          if (viewDirection.lengthSq() < 0.001) viewDirection.set(1, 0.8, 1)
          viewDirection.normalize()

          const distance = Math.max(1.2, size.length() * 1.7)
          controls.target.copy(center)
          camera.position.copy(center).addScaledVector(viewDirection, distance)
          camera.near = Math.max(0.01, distance / 100)
          camera.far = Math.max(100, distance * 20)
          camera.updateProjectionMatrix()
          controls.update()
          lastTrainCameraFocusIdRef.current = focusId
        }
      }
    } else {
      if (previousMode === 'train' && factoryCameraStateRef.current) {
        camera.position.copy(factoryCameraStateRef.current.position)
        controls.target.copy(factoryCameraStateRef.current.target)
        camera.near = factoryCameraStateRef.current.near
        camera.far = factoryCameraStateRef.current.far
        camera.updateProjectionMatrix()
        controls.update()
      }
      factoryCameraStateRef.current = null
      lastTrainCameraFocusIdRef.current = null
    }

    previousWorkspaceModeRef.current = workspaceMode
  }, [isRobotLoaded, robots.length, selectedRobotId, workspaceMode])

  // Apply motion state directly to the affected Three.js robot. Subscribing outside React keeps
  // a 30/60 fps trajectory from re-rendering the entire viewport and re-walking every robot.
  useEffect(() => {
    return useRobotStore.subscribe((state, previousState) => {
      if (
        state.jointAngles === previousState.jointAngles &&
        state.jointAnglesByRobotId === previousState.jointAnglesByRobotId
      ) {
        return
      }

      const changedRobotIds = new Set<string>()
      if (state.jointAnglesByRobotId !== previousState.jointAnglesByRobotId) {
        for (const [robotId, angles] of Object.entries(state.jointAnglesByRobotId)) {
          if (angles !== previousState.jointAnglesByRobotId[robotId]) changedRobotIds.add(robotId)
        }
      }
      if (state.selectedRobotId && state.jointAngles !== previousState.jointAngles) {
        changedRobotIds.add(state.selectedRobotId)
      }

      for (const robotId of changedRobotIds) {
        const robot = robotRefs.current.get(robotId)
        const angles =
          state.jointAnglesByRobotId[robotId] ??
          (robotId === state.selectedRobotId ? state.jointAngles : undefined)
        if (robot && angles) updateRobotJoints(angles, robot)
      }

      if (
        !state.selectedRobotId &&
        state.jointAngles !== previousState.jointAngles &&
        previewRobotRef.current
      ) {
        updateRobotJoints(state.jointAngles, previewRobotRef.current)
      }
      // Collision has its own 15 Hz scheduler. Triggering another exact scan for every animation
      // frame makes recorded trajectories stutter without improving the collision state machine.
    })
    // This subscription intentionally lives for the viewport lifetime and reads all mutable
    // robot objects through refs; resubscribing on each render would reintroduce playback churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync selectedRobotId and toggle home pose for non-active robots.
  // If no backend robot is available yet, keep the local preview robot active.
  useEffect(() => {
    const robotState = useRobotStore.getState()
    const activeRobot = selectedRobotId
      ? robotRefs.current.get(selectedRobotId) || null
      : robots.length === 0
        ? previewRobotRef.current
        : null

    robotRef.current = activeRobot
    setIsRobotLoaded(!!activeRobot)

    for (const [id, robot] of robotRefs.current.entries()) {
      const shouldBeVisible = workspaceMode === 'factory' || id === selectedRobotId
      if (robot.visible && !shouldBeVisible) {
        collisionEngineRef.current?.removeRobot(id)
      }
      robot.visible = shouldBeVisible

      const robotAngles =
        id === selectedRobotId
          ? robotState.jointAngles
          : (robotState.jointAnglesByRobotId[id] ?? [...DEFAULT_JOINT_ANGLES])

      updateRobotJoints(robotAngles, robot)
    }

    if (!selectedRobotId && robots.length === 0 && previewRobotRef.current) {
      previewRobotRef.current.visible = true
      updateRobotJoints(robotState.jointAngles, previewRobotRef.current)
    }

    collisionSchedulerRef.current?.requestImmediateTick()

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robots.length, selectedRobotId, workspaceMode])

  // Local preview robot for logged-out / empty backend state.
  // This robot is visual-only and is removed as soon as backend robots exist.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const sceneGeneration = sceneGenerationRef.current

    if (robots.length > 0) {
      previewRobotLoadGenerationRef.current += 1
      previewRobotLoadingRef.current = false

      const previewRobot = previewRobotRef.current

      if (previewRobot) {
        collisionEngineRef.current?.removeRobot(PREVIEW_COLLISION_ROBOT_ID)
        scene.remove(previewRobot)
        removeRobotMaterialCache(PREVIEW_COLLISION_ROBOT_ID)
        disposeRobotObject(previewRobot)
        previewRobotRef.current = null

        if (robotRef.current === previewRobot) {
          robotRef.current = null
          setIsRobotLoaded(false)
        }
      }

      removeRobotSafetyState(PREVIEW_COLLISION_ROBOT_ID)

      return
    }

    if (previewRobotRef.current || previewRobotLoadingRef.current) {
      return
    }

    const loadGeneration = previewRobotLoadGenerationRef.current + 1

    previewRobotLoadGenerationRef.current = loadGeneration
    previewRobotLoadingRef.current = true
    collisionLoadErrorRef.current = false
    updateCollisionReadiness('loading')

    loadUrdfRobotWhenAssetsReady({
      url: './fairino_description/urdf/fairino5_v6.urdf',
      packages: {
        fairino_description: './fairino_description'
      },
      onLoad: (loadedRobot) => {
        const loadIsCurrent =
          previewRobotLoadGenerationRef.current === loadGeneration &&
          sceneRef.current === scene &&
          sceneGenerationRef.current === sceneGeneration &&
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

        cacheRobotMaterials(PREVIEW_COLLISION_ROBOT_ID, loadedRobot)

        scene.add(loadedRobot)

        previewRobotRef.current = loadedRobot
        robotRef.current = loadedRobot

        setIsRobotLoaded(true)

        updateRobotJoints(useRobotStore.getState().jointAngles, loadedRobot)
        applyRobotSafetyVisual(PREVIEW_COLLISION_ROBOT_ID, true)
        collisionSchedulerRef.current?.requestImmediateTick()
        requestCollisionPrewarmRef.current()
      },
      onError: (error) => {
        if (previewRobotLoadGenerationRef.current === loadGeneration) {
          previewRobotLoadingRef.current = false
          collisionLoadErrorRef.current = true
          updateCollisionReadiness('error')
          console.error('An error occurred loading preview URDF:', error)
        }
      }
    })

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
    const sceneGeneration = sceneGenerationRef.current

    const existingIds = new Set(robotRefs.current.keys())
    const nextIds = new Set(robots.map((r) => r.id))

    // 1. Remove robots no longer in store
    for (const id of existingIds) {
      if (!nextIds.has(id)) {
        robotLoadGenerationByIdRef.current.set(
          id,
          (robotLoadGenerationByIdRef.current.get(id) ?? 0) + 1
        )
        const robotObj = robotRefs.current.get(id)
        if (robotObj) {
          scene.remove(robotObj)
          removeRobotMaterialCache(id)
          disposeRobotObject(robotObj)
          unregisterLoadedRobotMoveLRunner(id)
        }
        robotRefs.current.delete(id)
        collisionEngineRef.current?.removeRobot(id)
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
        robotLoadGenerationByIdRef.current.set(
          loadingId,
          (robotLoadGenerationByIdRef.current.get(loadingId) ?? 0) + 1
        )
        loadingRobotIdsRef.current.delete(loadingId)
        unregisterLoadedRobotMoveLRunner(loadingId)
      }
    }

    // 2. Load new robots or update existing placement
    robots.forEach((robot) => {
      const existingRobot = robotRefs.current.get(robot.id)
      if (existingRobot) {
        applyRobotSceneBinding(
          existingRobot,
          workspaceMode === 'train' && robot.id === selectedRobotId ? null : robot.sceneBinding
        )
        existingRobot.updateMatrixWorld(true)
      } else if (!loadingRobotIdsRef.current.has(robot.id)) {
        const robotLoadGeneration = (robotLoadGenerationByIdRef.current.get(robot.id) ?? 0) + 1
        robotLoadGenerationByIdRef.current.set(robot.id, robotLoadGeneration)
        loadingRobotIdsRef.current.add(robot.id)
        collisionLoadErrorRef.current = false
        updateCollisionReadiness('loading', robotRefs.current.size)

        loadUrdfRobotWhenAssetsReady({
          url: './fairino_description/urdf/fairino5_v6.urdf',
          packages: {
            fairino_description: './fairino_description'
          },
          onParsed: (loadedRobot) => {
            const currentRobot = robotsRef.current.find((item) => item.id === robot.id)
            const loadIsCurrent =
              sceneRef.current === scene &&
              sceneGenerationRef.current === sceneGeneration &&
              robotLoadGenerationByIdRef.current.get(robot.id) === robotLoadGeneration &&
              Boolean(currentRobot)

            if (loadIsCurrent && !robotRefs.current.has(robot.id)) {
              registerLoadedRobotMoveLRunner(robot.id, loadedRobot)
            }
          },
          onLoad: (loadedRobot) => {
            const currentRobot = robotsRef.current.find((item) => item.id === robot.id)
            const loadIsCurrent =
              sceneRef.current === scene &&
              sceneGenerationRef.current === sceneGeneration &&
              robotLoadGenerationByIdRef.current.get(robot.id) === robotLoadGeneration &&
              Boolean(currentRobot)
            const alreadyLoaded = robotRefs.current.has(robot.id)

            if (!loadIsCurrent || !currentRobot || alreadyLoaded) {
              disposeRobotObject(loadedRobot)
              if (robotLoadGenerationByIdRef.current.get(robot.id) === robotLoadGeneration) {
                loadingRobotIdsRef.current.delete(robot.id)
              }
              return
            }

            const currentRobotState = useRobotStore.getState()

            applyRobotSceneBinding(
              loadedRobot,
              currentRobotState.workspaceMode === 'train' &&
                robot.id === currentRobotState.selectedRobotId
                ? null
                : currentRobot.sceneBinding
            )

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

            loadedRobot.visible =
              currentRobotState.workspaceMode === 'factory' ||
              robot.id === currentRobotState.selectedRobotId

            scene.add(loadedRobot)
            robotRefs.current.set(robot.id, loadedRobot)
            applyRobotSafetyVisual(robot.id, true)
            loadingRobotIdsRef.current.delete(robot.id)
            // Initial joints position sync
            const robotAngles =
              robot.id === currentRobotState.selectedRobotId
                ? currentRobotState.jointAngles
                : (currentRobotState.jointAnglesByRobotId[robot.id] ?? [...DEFAULT_JOINT_ANGLES])

            if (robot.id === currentRobotState.selectedRobotId) {
              robotRef.current = loadedRobot
              setIsRobotLoaded(true)
            }

            updateRobotJoints(robotAngles, loadedRobot)
            loadedRobot.updateMatrixWorld(true)
            collisionSchedulerRef.current?.requestImmediateTick()
            requestCollisionPrewarmRef.current()
          },
          onError: (error) => {
            const loadIsCurrent =
              sceneRef.current === scene &&
              sceneGenerationRef.current === sceneGeneration &&
              robotLoadGenerationByIdRef.current.get(robot.id) === robotLoadGeneration
            if (loadIsCurrent) {
              console.error('An error occurred loading URDF:', error)
              loadingRobotIdsRef.current.delete(robot.id)
              collisionLoadErrorRef.current = true
              if (robotRefs.current.size === 0) updateCollisionReadiness('error')
            }
          }
        })
      }
    })
    collisionSchedulerRef.current?.requestImmediateTick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robots, selectedRobotId, workspaceMode])

  function applyRobotJointValues(angles: number[], robot: FairinoRobotObject): void {
    const jointNames = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6']
    jointNames.forEach((name, index) => {
      const joint = robot.joints[name]
      if (!joint) return

      const angleValue = Number.isNaN(angles[index]) ? 0 : angles[index]
      joint.setJointValue((angleValue * Math.PI) / 180)
    })
    robot.updateMatrixWorld(true)
  }

  function getRobotTcpPose(robot: FairinoRobotObject): TCPPose | null {
    const baseLink = robot.links['base_link']
    const wristLink = robot.links['wrist3_link']
    if (!baseLink || !wristLink) return null

    const baseMatrixInverse = new THREE.Matrix4().copy(baseLink.matrixWorld).invert()
    const relativeMatrix = new THREE.Matrix4().multiplyMatrices(
      baseMatrixInverse,
      wristLink.matrixWorld
    )
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    relativeMatrix.decompose(position, quaternion, new THREE.Vector3())

    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ')
    const toMillimeters = (value: number): number =>
      Number.isNaN(value) ? 0 : Math.round(value * 10000) / 10
    const toDegrees = (value: number): number =>
      Number.isNaN(value) ? 0 : Math.round(((value * 180) / Math.PI) * 10) / 10

    return {
      x: toMillimeters(position.x),
      y: toMillimeters(position.y),
      z: toMillimeters(position.z),
      rx: toDegrees(euler.x),
      ry: toDegrees(euler.y),
      rz: toDegrees(euler.z)
    }
  }

  // Helper function to update joint angles, calculate TCP Pose and snap Gizmo Target
  function updateRobotJoints(angles: number[], targetRobot?: FairinoRobotObject | null): void {
    const robot = targetRobot !== undefined ? targetRobot : robotRef.current
    const dummyTarget = dummyTargetRef.current
    if (!robot) return

    applyRobotJointValues(angles, robot)

    let robotId: string | null = null

    for (const [id, loadedRobot] of robotRefs.current.entries()) {
      if (loadedRobot === robot) {
        robotId = id
        break
      }
    }

    const wristLink = robot.links['wrist3_link']
    const nextTcpPose = getRobotTcpPose(robot)
    if (!wristLink || !nextTcpPose) return

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

  const isCartesianTraceInputMode =
    workspaceMode === 'train' && isIKMode && cartesianInteractionMode === 'trace' && !isPlaying
  const cartesianTraceSpeedLabel =
    cartesianTraceSpeedMode === 'fast'
      ? language === 'vi'
        ? 'Nhanh · 2×'
        : 'Fast · 2×'
      : cartesianTraceSpeedMode === 'precision'
        ? language === 'vi'
          ? 'Chính xác · 0.25×'
          : 'Precision · 0.25×'
        : language === 'vi'
          ? 'Bình thường · 1×'
          : 'Normal · 1×'

  return (
    <div ref={containerRef} className="relative h-full w-full min-h-0 min-w-0 overflow-hidden">
      <div
        role="status"
        aria-live="polite"
        data-testid="collision-readiness"
        className={`pointer-events-none absolute bottom-4 right-4 z-30 flex items-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-semibold shadow-lg backdrop-blur-sm ${
          collisionReadiness.status === 'ready'
            ? 'border-emerald-500/40 bg-emerald-950/90 text-emerald-200'
            : collisionReadiness.status === 'error'
              ? 'border-rose-500/50 bg-rose-950/90 text-rose-200'
              : 'border-amber-500/40 bg-amber-950/90 text-amber-200'
        }`}
      >
        <span
          className={`h-2 w-2 rounded-full ${
            collisionReadiness.status === 'ready'
              ? 'bg-emerald-400'
              : collisionReadiness.status === 'error'
                ? 'bg-rose-400'
                : 'animate-pulse bg-amber-400'
          }`}
        />
        <span>
          {collisionReadiness.status === 'ready'
            ? language === 'vi'
              ? `Collision sẵn sàng (${collisionReadiness.robotCount} robot)`
              : `Collision ready (${collisionReadiness.robotCount} robot)`
            : collisionReadiness.status === 'error'
              ? language === 'vi'
                ? 'Collision chưa sẵn sàng — lỗi tải geometry'
                : 'Collision unavailable — geometry load error'
              : language === 'vi'
                ? 'Đang khởi tạo collision...'
                : 'Initializing collision...'}
        </span>
      </div>

      {/* Dynamic measurement label */}
      <div
        id="measure-label"
        className="absolute bg-[#1e1e24]/95 border border-blue-500/50 text-[10px] text-white px-2 py-1 rounded shadow-md pointer-events-none font-mono font-bold z-20 flex items-center gap-1.5"
        style={{ display: 'none', transform: 'translate(-50%, -50%)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping"></span>
        <span id="measure-text">0 mm</span>
      </div>

      {/* Fixed self-measurement HUD: keep diagnostic text away from the robot and gizmos. */}
      <div
        id="self-measure-label"
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute right-4 top-24 z-20 flex max-w-[min(360px,calc(100%-32px))] items-center gap-1.5 rounded-md border border-amber-500/50 bg-[#1e1e24]/95 px-2.5 py-1.5 font-mono text-[10px] font-bold text-white shadow-md backdrop-blur-sm"
        style={{ display: 'none' }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>
        <span id="self-measure-text">0 mm</span>
      </div>

      {/* Collision warning stays mounted so appearance/disappearance can animate smoothly. */}
      <div
        role="alert"
        aria-live="assertive"
        aria-hidden={!collisionAlert}
        className={`pointer-events-none absolute left-1/2 top-4 z-30 w-[min(560px,calc(100%-32px))] -translate-x-1/2 transition-all duration-200 ease-out ${
          collisionAlert ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
        }`}
      >
        <div
          className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-white backdrop-blur-sm pointer-events-auto ${
            collisionAlert?.level === 'proximity'
              ? 'border-amber-400/60 bg-amber-950/95 shadow-[0_0_28px_rgba(245,158,11,0.22)]'
              : 'border-rose-400/60 bg-rose-950/95 shadow-[0_0_28px_rgba(244,63,94,0.28)]'
          }`}
        >
          <span
            className={`relative mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
              collisionAlert?.level === 'proximity' ? 'bg-amber-500/20' : 'bg-rose-500/20'
            }`}
          >
            <span
              className={`absolute inset-0 rounded-full motion-safe:animate-ping ${
                collisionAlert?.level === 'proximity' ? 'bg-amber-400/25' : 'bg-rose-400/25'
              }`}
            />
            <ShieldAlert className="relative" size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={`text-xs font-bold ${
                collisionAlert?.level === 'proximity' ? 'text-amber-100' : 'text-rose-100'
              }`}
            >
              {collisionAlert?.title ??
                (language === 'vi' ? 'Phát hiện va chạm' : 'Collision detected')}
            </p>
            <p
              className={`mt-0.5 text-[10px] leading-relaxed ${
                collisionAlert?.level === 'proximity' ? 'text-amber-200/90' : 'text-rose-200/90'
              }`}
            >
              {collisionAlert?.detail ??
                (language === 'vi'
                  ? 'Hãy kiểm tra vùng làm việc của robot.'
                  : 'Check the robot work area.')}
            </p>

            {collisionAlert && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setIsTechnicalDetailsExpanded(!isTechnicalDetailsExpanded)}
                  className={`text-[9px] font-semibold underline cursor-pointer hover:opacity-80 focus:outline-none ${
                    collisionAlert.level === 'proximity' ? 'text-amber-300' : 'text-rose-300'
                  }`}
                >
                  {isTechnicalDetailsExpanded
                    ? language === 'vi'
                      ? 'Ẩn chi tiết kỹ thuật'
                      : 'Hide technical details'
                    : language === 'vi'
                      ? 'Xem chi tiết kỹ thuật'
                      : 'Show technical details'}
                </button>
                {isTechnicalDetailsExpanded && (
                  <div
                    className={`mt-1.5 rounded p-2 text-[9px] font-mono leading-normal whitespace-pre-wrap max-h-24 overflow-y-auto select-text ${
                      collisionAlert.level === 'proximity'
                        ? 'bg-amber-900/60 text-amber-200 border border-amber-500/20'
                        : 'bg-rose-900/60 text-rose-200 border border-rose-500/20'
                    }`}
                  >
                    {getTechnicalInfoSummary()}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

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

      {/* Context-aware shortcuts. Trace mode owns WASD, so never advertise camera control there. */}
      {isCartesianTraceInputMode ? (
        <div className="absolute top-4 right-4 z-20 w-[270px] overflow-hidden rounded-lg border border-cyan-500/30 bg-[#11151d]/95 text-slate-300 shadow-xl backdrop-blur-sm">
          <button
            type="button"
            onClick={() => setIsCartesianTraceHelpExpanded((expanded) => !expanded)}
            aria-expanded={isCartesianTraceHelpExpanded}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-white/5"
          >
            <span className="flex min-w-0 items-center gap-2 text-[10px] font-semibold text-cyan-200">
              <CircleAlert size={15} className="shrink-0" />
              <span className="truncate">
                {language === 'vi' ? 'Hướng dẫn vẽ quỹ đạo' : 'Trace controls'}
              </span>
            </span>
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 text-[8px] font-semibold ${
                cartesianTraceSpeedMode === 'fast'
                  ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                  : cartesianTraceSpeedMode === 'precision'
                    ? 'border-violet-400/30 bg-violet-500/10 text-violet-200'
                    : 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200'
              }`}
            >
              {cartesianTraceSpeedLabel}
            </span>
          </button>

          {isCartesianTraceHelpExpanded && (
            <div className="space-y-1.5 border-t border-white/5 px-3 py-2.5 text-[9px] leading-relaxed text-slate-400">
              <div className="grid grid-cols-[90px_1fr] gap-x-2 gap-y-1">
                <span className="font-semibold text-slate-200">
                  {language === 'vi' ? 'Chuột trái' : 'Left mouse'}
                </span>
                <span>{language === 'vi' ? 'Di chuyển TCP' : 'Move TCP'}</span>
                <span className="font-semibold text-slate-200">W · ↑</span>
                <span>{language === 'vi' ? 'J4 lên' : 'J4 up'}</span>
                <span className="font-semibold text-slate-200">S · ↓</span>
                <span>{language === 'vi' ? 'J4 xuống' : 'J4 down'}</span>
                <span className="font-semibold text-slate-200">A/D · ←/→</span>
                <span>{language === 'vi' ? 'Điều khiển J5' : 'Control J5'}</span>
                <span className="font-semibold text-slate-200">Q/E</span>
                <span>{language === 'vi' ? 'Điều khiển J6' : 'Control J6'}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 border-t border-white/5 pt-1.5">
                <span>
                  <b className="text-slate-200">Shift</b> {language === 'vi' ? 'Nhanh' : 'Fast'}
                </span>
                <span>
                  <b className="text-slate-200">Ctrl</b>{' '}
                  {language === 'vi' ? 'Chính xác' : 'Precision'}
                </span>
                <span>
                  <b className="text-slate-200">
                    {language === 'vi' ? 'Chuột phải' : 'Right click'}
                  </b>{' '}
                  {language === 'vi' ? 'Lưu' : 'Save'}
                </span>
                <span>
                  <b className="text-slate-200">Esc</b> {language === 'vi' ? 'Hủy' : 'Cancel'}
                </span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="pointer-events-none absolute top-4 right-4 z-10 flex max-w-[190px] items-start gap-1.5 rounded-lg border border-[#343849] bg-[#141720]/85 p-2.5 text-slate-400 shadow-lg backdrop-blur-sm transition">
          <HelpCircle size={13} className="mt-0.5 shrink-0 text-blue-400" />
          <div className="space-y-1 text-[9px]">
            <span className="block font-bold text-white">Phím tắt:</span>
            <div>
              <span className="font-semibold text-slate-300">W/A/S/D</span> - Di chuyển Camera
            </div>
            {selectedObjectId && (
              <div className="mt-1 space-y-0.5 border-t border-white/5 pt-1.5">
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
      )}

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
        <div className="absolute bottom-4 left-4 z-10 max-w-sm rounded-lg border border-emerald-500/20 bg-[#141720]/90 px-3.5 py-2.5 text-slate-200 shadow-lg backdrop-blur-sm pointer-events-none">
          <div className="flex items-center gap-1.5 text-emerald-400 font-semibold text-[10px] mb-1">
            <span
              className={`h-1.5 w-1.5 rounded-full bg-emerald-500 ${
                cartesianTraceUi.status === 'recording' ? 'animate-ping' : ''
              }`}
            ></span>
            {cartesianInteractionMode === 'trace'
              ? language === 'vi'
                ? 'CARTESIAN — VẼ QUỸ ĐẠO'
                : 'CARTESIAN — TRACE PATH'
              : 'CARTESIAN (IK)'}
          </div>
          {cartesianInteractionMode !== 'trace' && (
            <p className="text-[10px] leading-normal text-slate-400">
              {language === 'vi'
                ? 'Kéo Gizmo hoặc điểm điều khiển tại đầu robot để di chuyển Cartesian.'
                : 'Drag the Gizmo or TCP control point to move in Cartesian space.'}
            </p>
          )}
          {cartesianInteractionMode === 'trace' && (
            <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-white/5 pt-1.5 text-[9px]">
              <span
                className={
                  cartesianTraceUi.status === 'ready'
                    ? 'text-cyan-300'
                    : cartesianTraceUi.status === 'recording'
                      ? 'text-emerald-300'
                      : 'text-slate-500'
                }
              >
                {cartesianTraceUi.status === 'recording'
                  ? language === 'vi'
                    ? 'Đang ghi'
                    : 'Recording'
                  : cartesianTraceUi.status === 'ready'
                    ? language === 'vi'
                      ? 'Tạm dừng · có thể vẽ tiếp'
                      : 'Paused · ready to continue'
                    : language === 'vi'
                      ? 'Chờ thao tác'
                      : 'Waiting'}
              </span>
              <span className="font-mono text-slate-400">
                {cartesianTraceUi.rawSampleCount} pts ·{' '}
                {(cartesianTraceUi.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
          )}
          {cartesianInteractionMode === 'trace' && cartesianTraceNotice && (
            <p className="mt-1 text-[9px] text-amber-300">{cartesianTraceNotice}</p>
          )}
        </div>
      )}
    </div>
  )
}
