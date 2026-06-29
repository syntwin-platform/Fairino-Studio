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

import { getRobotRuntimeConfig, registerMoveLRunner } from '../../services/robotMotionRuntime'
import { cancelActiveCommand, throwIfCommandCancelled } from '../../services/commandExecutionRuntime'

import { DEFAULT_JOINT_ANGLES } from '../../types/robot.types'
import type { JointAngles, TCPPose, WorkflowStep } from '../../types/robot.types'
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

function toJointAngles(values: number[]): JointAngles {
  return values.slice(0, 6) as JointAngles
}

type HighlightableMaterial = THREE.Material & {
  emissive: THREE.Color
  emissiveIntensity: number
}

function isHighlightableMaterial(material: THREE.Material): material is HighlightableMaterial {
  return 'emissive' in material && material.emissive instanceof THREE.Color && 'emissiveIntensity' in material
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

  // Track loaded 3D models: map objectId -> THREE.Object3D
  const loadedObjectsRef = useRef<Map<string, THREE.Object3D>>(new Map())

  // Cache the last user config JSON to block infinite store update loop
  const lastUserConfigRef = useRef<string>('')

  const jointAngles = useRobotStore((state) => state.jointAngles)
  const setJointAngles = useRobotStore((state) => state.setJointAngles)
  const setTCPPose = useRobotStore((state) => state.setTCPPose)
  const isIKMode = useRobotStore((state) => state.isIKMode)
  const isPlaying = useRobotStore((state) => state.isPlaying)
  const selectedJointName = useRobotStore((state) => state.selectedJointName)
  const steps = useRobotStore((state) => state.steps)

  const objects = useSceneStore((state) => state.objects)
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId)
  const collisionWarning = useSceneStore((state) => state.collisionWarning)
  const setCollisionWarning = useSceneStore((state) => state.setCollisionWarning)

  useEffect(() => {
    if (!collisionWarning || !isPlaying) {
      return
    }

    cancelActiveCommand('Collision detected by Fairino Studio')
    useRobotStore.getState().setPlaying(false)
  }, [collisionWarning, isPlaying])

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

  useEffect(() => {
    return registerMoveLRunner(async (targetPose, speed, signal): Promise<void> => {
      throwIfCommandCancelled(signal)

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

      const frameDelayMs = Math.max(16, 110 - speed)

      useRobotStore.getState().setPlaying(true)

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
        useRobotStore.getState().setPlaying(false)
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
      ...(s.type === 'MoveL' ? { tcpPose: s.tcpPose } : {})
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
          if (!step.tcpPose) {
            nextTCP = computeFK(nextJoints, robot)
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
        if (
          !step.tcpPose ||
          Math.abs(step.tcpPose.x - fkTCP.x) > 0.5 ||
          Math.abs(step.tcpPose.z - fkTCP.z) > 0.5
        ) {
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
          if (
            !step.tcpPose ||
            Math.abs(step.tcpPose.x - nextTCP.x) > 0.5 ||
            Math.abs(step.tcpPose.z - nextTCP.z) > 0.5
          ) {
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
        if (
          !step.tcpPose ||
          Math.abs(step.tcpPose.x - fkTCP.x) > 0.5 ||
          Math.abs(step.tcpPose.z - fkTCP.z) > 0.5
        ) {
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
    const width = container.clientWidth
    const height = container.clientHeight

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#141417') // Dark industrial bg
    sceneRef.current = scene

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
    camera.position.set(1.5, 1.5, 1.5)

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
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

    // Disable OrbitControls when dragging gizmo
    transformControls.addEventListener('dragging-changed', (event) => {
      controls.enabled = !event.value
    })

    // Listen to changes on Gizmo dragging
    transformControls.addEventListener('objectChange', () => {
      const playing = useRobotStore.getState().isPlaying
      if (playing) return

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

          const currentAngles = useRobotStore.getState().jointAngles
          const newAngles = solveIK(clampedTargetPos, targetQuat, currentAngles, robot)

          if (newAngles) {
            setJointAngles(newAngles)
          }
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

    // Load URDF Robot
    const loader = new URDFLoader()
    loader.packages = {
      fairino_description: './fairino_description'
    }

    loader.load(
      './fairino_description/urdf/fairino5_v6.urdf',
      (robot) => {
        robot.rotation.x = -Math.PI / 2
        robot.position.y = 0

        robot.traverse((child) => {
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

        scene.add(robot)
        robotRef.current = robot
        setIsRobotLoaded(true)

        updateRobotJoints(useRobotStore.getState().jointAngles)
      },
      undefined,
      (error) => {
        console.error('An error occurred loading URDF:', error)
      }
    )

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
      const robot = robotRef.current
      if (robot) {
        const intersects = raycaster.intersectObject(robot, true)
        if (intersects.length > 0) {
          let obj: THREE.Object3D | null = intersects[0].object
          let jointName: string | null = null

          while (obj && obj !== robot) {
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
            useRobotStore.getState().setSelectedJointName(jointName)
            useSceneStore.getState().setSelectedObjectId(null) // clear selected object
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
          ; (h.material as THREE.Material).dispose()
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

    const animate = (): void => {
      animationFrameId = requestAnimationFrame(animate)
      controls.update()

      // Update outline helper for selected objects
      if (boxHelperRef.current && boxHelperRef.current.visible) {
        boxHelperRef.current.update()
      }

      // Perform WASD Camera Navigation
      updateWASDNavigation()

      // Perform collision detection
      checkCollisions()

      // Update measurement line and debug hitboxes
      updateMeasurementAndHitboxes()

      renderer.render(scene, camera)
    }
    animate()

    // Resize Handler
    const handleResize = (): void => {
      if (!container) return
      const w = container.clientWidth
      const h = container.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    window.addEventListener('resize', handleResize)

    // Clean up
    return () => {
      cancelAnimationFrame(animationFrameId)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.dispose()
      transformControls.dispose()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
    // This effect owns the Three.js scene lifecycle and must run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Bounding box collision detection (Ground, Self, and Object collision)
  function checkCollisions(): void {
    const robot = robotRef.current
    if (!robot) return

    // 1. Compute OBB for each named URDF link, stopping traversal at link boundaries
    const allLinkObjs = new Set<THREE.Object3D>(
      Object.values(robot.links as Record<string, THREE.Object3D>)
    )
    const linkOBBMap = new Map<string, OBB>()
    if (robot.links) {
      for (const [name, linkObj] of Object.entries(robot.links as Record<string, THREE.Object3D>)) {
        const obb = computeLinkOBB(linkObj, allLinkObjs)
        if (obb) linkOBBMap.set(name, obb)
      }
    }

    // 2. Ground Collision Detection: check if any link's OBB min Y < 5mm
    //    Approximate by checking the 8 corners of the OBB
    let groundCollide = false
    const SKIP_LINKS_GROUND = ['base_link', 'shoulder_link']
    for (const [linkName, obb] of linkOBBMap.entries()) {
      if (SKIP_LINKS_GROUND.some((s) => linkName.toLowerCase().includes(s))) continue
      const { center, halfSize, rotation } = obb
      let minY = Infinity
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (const sz of [-1, 1]) {
            const corner = new THREE.Vector3(sx * halfSize.x, sy * halfSize.y, sz * halfSize.z)
              .applyMatrix3(rotation)
              .add(center)
            if (corner.y < minY) minY = corner.y
          }
      if (minY < 0.005) {
        groundCollide = true
        break
      }
    }

    // 3. Self Collision Detection using OBB
    let selfCollide = false
    for (const pair of SELF_COLLISION_PAIRS) {
      let obbA: OBB | undefined
      let obbB: OBB | undefined
      for (const [key, obb] of linkOBBMap.entries()) {
        const kl = key.toLowerCase()
        if (kl.includes(pair.a)) obbA = obb
        if (kl.includes(pair.b)) obbB = obb
      }
      if (obbA && obbB && obbA.intersectsOBB(obbB)) {
        selfCollide = true
        break
      }
    }

    // 4. Object Collision Detection using OBB.intersectsBox3
    let objectCollide = false
    if (loadedObjectsRef.current.size > 0) {
      for (const [id, threeObj] of loadedObjectsRef.current.entries()) {
        const storeObj = useSceneStore.getState().objects.find((o) => o.id === id)
        if (!storeObj || !storeObj.visible) continue
        const objBox = new THREE.Box3().setFromObject(threeObj)
        for (const obb of linkOBBMap.values()) {
          if (obb.intersectsBox3(objBox)) {
            objectCollide = true
            break
          }
        }
        if (objectCollide) break
      }
    }

    const isColliding = groundCollide || selfCollide || objectCollide
    if (useSceneStore.getState().collisionWarning !== isColliding) {
      setCollisionWarning(isColliding)
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
  }, [isIKMode, isRobotLoaded, isPlaying, selectedJointName, selectedObjectId])

  // Update robot joints when jointAngles state changes
  useEffect(() => {
    updateRobotJoints(jointAngles)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jointAngles])

  // Helper function to update joint angles, calculate TCP Pose and snap Gizmo Target
  function updateRobotJoints(angles: number[]): void {
    const robot = robotRef.current
    const dummyTarget = dummyTargetRef.current
    if (!robot) return

    const jointNames = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6']
    jointNames.forEach((name, idx) => {
      const joint = robot.joints[name]
      if (joint) {
        const angleVal = isNaN(angles[idx]) ? 0 : angles[idx]
        const rad = (angleVal * Math.PI) / 180
        joint.setJointValue(rad)
      }
    })

    robot.updateMatrixWorld(true)

    const baseLink = robot.links['base_link']
    const wristLink = robot.links['wrist3_link']

    if (baseLink && wristLink) {
      const baseMatInv = new THREE.Matrix4().copy(baseLink.matrixWorld).invert()
      const relativeMat = new THREE.Matrix4().multiplyMatrices(baseMatInv, wristLink.matrixWorld)

      const pos = new THREE.Vector3()
      const q = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      relativeMat.decompose(pos, q, scale)

      const x = isNaN(pos.x) ? 0 : Math.round(pos.x * 1000 * 10) / 10
      const y = isNaN(pos.y) ? 0 : Math.round(pos.y * 1000 * 10) / 10
      const z = isNaN(pos.z) ? 0 : Math.round(pos.z * 1000 * 10) / 10

      const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ')
      const rx = isNaN(euler.x) ? 0 : Math.round(((euler.x * 180) / Math.PI) * 10) / 10
      const ry = isNaN(euler.y) ? 0 : Math.round(((euler.y * 180) / Math.PI) * 10) / 10
      const rz = isNaN(euler.z) ? 0 : Math.round(((euler.z * 180) / Math.PI) * 10) / 10

      setTCPPose({ x, y, z, rx, ry, rz })

      if (dummyTarget && !transformControlsRef.current?.dragging) {
        const wristWorldPos = new THREE.Vector3()
        const wristWorldQuat = new THREE.Quaternion()
        wristLink.getWorldPosition(wristWorldPos)
        wristLink.getWorldQuaternion(wristWorldQuat)

        dummyTarget.position.copy(wristWorldPos)
        dummyTarget.quaternion.copy(wristWorldQuat)
        dummyTarget.updateMatrixWorld(true)
      }
    }
  }

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
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
        <div className="absolute top-4 left-4 z-10 flex items-center gap-2 bg-rose-600/95 text-white px-4 py-2.5 rounded-lg shadow-lg border border-rose-500 animate-pulse">
          <ShieldAlert size={18} />
          <span className="text-xs font-bold uppercase tracking-wider">
            Cảnh báo: Phát hiện va chạm!
          </span>
        </div>
      )}

      {/* Helper floating shortcuts hint */}
      <div className="absolute top-4 right-4 z-10 bg-[#1e1e24]/90 border border-blue-500/30 text-slate-300 px-3.5 py-2.5 rounded-lg shadow-xl backdrop-blur-sm max-w-[240px] pointer-events-none flex items-start gap-2">
        <HelpCircle size={14} className="text-blue-400 shrink-0 mt-0.5" />
        <div className="text-[10px] space-y-1.5">
          <span className="font-bold text-white block">Phím tắt điều hướng:</span>
          <div>
            <kbd className="px-1.5 py-0.5 bg-black/40 rounded text-slate-200">W</kbd>{' '}
            <kbd className="px-1.5 py-0.5 bg-black/40 rounded text-slate-200">A</kbd>{' '}
            <kbd className="px-1.5 py-0.5 bg-black/40 rounded text-slate-200">S</kbd>{' '}
            <kbd className="px-1.5 py-0.5 bg-black/40 rounded text-slate-200">D</kbd> - Di chuyển
            Camera
          </div>
          {selectedObjectId && (
            <>
              <div className="border-t border-white/10 my-1"></div>
              <span className="font-bold text-white block">Thiết lập vật thể:</span>
              <div>
                <kbd className="px-1.5 py-0.5 bg-black/40 rounded text-slate-200">1</kbd> - Dịch
                chuyển (Translate)
              </div>
              <div>
                <kbd className="px-1.5 py-0.5 bg-black/40 rounded text-slate-200">2</kbd> - Xoay
                (Rotate)
              </div>
              <div>
                <kbd className="px-1.5 py-0.5 bg-black/40 rounded text-slate-200">3</kbd> - Co giãn
                (Scale)
              </div>
            </>
          )}
        </div>
      </div>

      {/* IK Mode Instructions */}
      {isIKMode && (
        <div className="absolute bottom-4 left-4 z-10 bg-[#1e1e24]/90 border border-emerald-500/30 text-slate-200 px-4 py-3 rounded-lg shadow-xl backdrop-blur-sm max-w-sm pointer-events-none">
          <div className="flex items-center gap-2 text-emerald-400 font-semibold text-xs mb-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
            CHẾ ĐỘ CARTESIAN (IK) HOẠT ĐỘNG
          </div>
          <p className="text-[11px] text-slate-300 leading-relaxed">
            Kéo các mũi tên 3D (Gizmo) hoặc quả cầu phát sáng màu xanh cyan ở đầu gắp robot để điều
            khiển vị trí của cánh tay.
          </p>
        </div>
      )}
    </div>
  )
}
