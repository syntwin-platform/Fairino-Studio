import * as THREE from 'three'
import type { JointAngles } from '../../types/robot.types'

interface RobotJoint {
  angle?: number
  jointValue?: number
  setJointValue: (value: number) => void
}

interface FairinoRobotObject extends THREE.Object3D {
  joints: Record<string, RobotJoint>
  links: Record<string, THREE.Object3D>
}

const JOINT_LIMITS = [
  { minRad: (-175 * Math.PI) / 180, maxRad: (175 * Math.PI) / 180 }, // j1
  { minRad: (-265 * Math.PI) / 180, maxRad: (85 * Math.PI) / 180 }, // j2
  { minRad: (-160 * Math.PI) / 180, maxRad: (160 * Math.PI) / 180 }, // j3
  { minRad: (-265 * Math.PI) / 180, maxRad: (85 * Math.PI) / 180 }, // j4
  { minRad: (-175 * Math.PI) / 180, maxRad: (175 * Math.PI) / 180 }, // j5
  { minRad: (-175 * Math.PI) / 180, maxRad: (175 * Math.PI) / 180 } // j6
]

// Gaussian elimination to solve Ax = B
function solveLinearSystem(A: number[][], B: number[]): number[] {
  const n = B.length
  const M = A.map((row, i) => [...row, B[i]])

  for (let i = 0; i < n; i++) {
    // Find pivot
    let maxEl = Math.abs(M[i][i])
    let maxRow = i
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > maxEl) {
        maxEl = Math.abs(M[k][i])
        maxRow = k
      }
    }

    // Pivot swap
    const temp = M[maxRow]
    M[maxRow] = M[i]
    M[i] = temp

    // Prevent divide by zero (singular matrix check, preserving sign)
    if (Math.abs(M[i][i]) < 1e-12) {
      M[i][i] = M[i][i] >= 0 ? 1e-12 : -1e-12
    }

    // Eliminate below pivot
    for (let k = i + 1; k < n; k++) {
      const c = -M[k][i] / M[i][i]
      for (let j = i; j <= n; j++) {
        if (i === j) {
          M[k][j] = 0
        } else {
          M[k][j] += c * M[i][j]
        }
      }
    }
  }

  // Back substitution
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n] / M[i][i]
    for (let k = i - 1; k >= 0; k--) {
      M[k][n] -= M[k][i] * x[i]
    }
  }
  return x
}

/**
 * Solve Inverse Kinematics for Fairino FR5 robot.
 * Uses Damped Least Squares Jacobian numerical solver.
 */
export function solveIK(
  targetPos: THREE.Vector3, // Target position in meters (robot coordinate frame)
  targetQuat: THREE.Quaternion, // Target orientation (robot coordinate frame)
  currentAngles: JointAngles, // Current joint angles in degrees
  robotObj: FairinoRobotObject | null | undefined // Three.js robot object loaded by urdf-loader
): JointAngles | null {
  if (!robotObj) return null

  const jointNames = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6']
  const joints = jointNames.map((name) => robotObj.joints[name])
  const baseLink = robotObj.links['base_link']
  const wristLink = robotObj.links['wrist3_link']

  if (!baseLink || !wristLink || joints.some((j) => !j)) return null

  // Backup current joint states (use j.angle, fallback to jointValue, prevent NaN)
  const backupAngles = joints.map((j) => {
    const val = j.angle !== undefined ? j.angle : j.jointValue !== undefined ? j.jointValue : 0
    return isNaN(val) ? 0 : val
  })

  // Initialize joint working state in radians, prevent starting from NaN
  const q = currentAngles.map((deg) => {
    const val = (deg * Math.PI) / 180
    return isNaN(val) ? 0 : val
  })

  const maxIterations = 20
  const tolerancePos = 0.0005 // 0.5 mm in meters
  const toleranceRot = 0.001 // ~0.05 degrees in radians
  const damping = 0.15 // Damping factor lambda (increased for singularity damping & smoothness)
  for (let iter = 0; iter < maxIterations; iter++) {
    // 1. Update robot joints with current iterate q
    jointNames.forEach((name, idx) => {
      robotObj.joints[name].setJointValue(q[idx])
    })
    robotObj.updateMatrixWorld(true)

    // 2. Get current end-effector position and orientation relative to base_link
    const baseMatInv = new THREE.Matrix4().copy(baseLink.matrixWorld).invert()
    const relativeMat = new THREE.Matrix4().multiplyMatrices(baseMatInv, wristLink.matrixWorld)

    const currPos = new THREE.Vector3()
    const currQuat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    relativeMat.decompose(currPos, currQuat, scale)

    // 3. Compute Position Error
    const errPos = new THREE.Vector3().subVectors(targetPos, currPos)

    // 4. Compute Rotation Error (quaternion difference)
    const errQuat = new THREE.Quaternion().copy(targetQuat).multiply(currQuat.clone().invert())
    if (errQuat.w < 0) {
      errQuat.x = -errQuat.x
      errQuat.y = -errQuat.y
      errQuat.z = -errQuat.z
      errQuat.w = -errQuat.w
    }

    const angle = 2 * Math.acos(Math.min(1, Math.max(-1, errQuat.w)))
    const errRot = new THREE.Vector3()
    if (angle > 1e-6) {
      const s = Math.sqrt(1 - errQuat.w * errQuat.w)
      if (s > 1e-6) {
        errRot.set(errQuat.x / s, errQuat.y / s, errQuat.z / s).multiplyScalar(angle)
      }
    }

    // Check if error is within tolerance
    const errorPosNorm = errPos.length()
    const errorRotNorm = errRot.length()
    if (errorPosNorm < tolerancePos && errorRotNorm < toleranceRot) {
      break
    }

    // 5. Construct 6-dimensional error vector
    const e = [errPos.x, errPos.y, errPos.z, errRot.x, errRot.y, errRot.z]

    // 6. Compute Numerical Jacobian (6x6 matrix)
    const delta = 1e-5
    const J = Array.from({ length: 6 }, () => new Array(6).fill(0))

    for (let j = 0; j < 6; j++) {
      // Positive step
      q[j] += delta
      jointNames.forEach((name, idx) => {
        robotObj.joints[name].setJointValue(q[idx])
      })
      robotObj.updateMatrixWorld(true)

      const relMatPlus = new THREE.Matrix4().multiplyMatrices(baseMatInv, wristLink.matrixWorld)
      const posPlus = new THREE.Vector3()
      const quatPlus = new THREE.Quaternion()
      relMatPlus.decompose(posPlus, quatPlus, scale)

      // Negative step
      q[j] -= 2 * delta
      jointNames.forEach((name, idx) => {
        robotObj.joints[name].setJointValue(q[idx])
      })
      robotObj.updateMatrixWorld(true)

      const relMatMinus = new THREE.Matrix4().multiplyMatrices(baseMatInv, wristLink.matrixWorld)
      const posMinus = new THREE.Vector3()
      const quatMinus = new THREE.Quaternion()
      relMatMinus.decompose(posMinus, quatMinus, scale)

      // Restore joint angle
      q[j] += delta

      // Positional gradient (dP/dq)
      const dPos = new THREE.Vector3().subVectors(posPlus, posMinus).multiplyScalar(1 / (2 * delta))

      // Rotational gradient (dRot/dq)
      const dq = new THREE.Quaternion().copy(quatPlus).multiply(quatMinus.clone().invert())
      if (dq.w < 0) {
        dq.x = -dq.x
        dq.y = -dq.y
        dq.z = -dq.z
        dq.w = -dq.w
      }
      const dAngle = 2 * Math.acos(Math.min(1, Math.max(-1, dq.w)))
      const dRot = new THREE.Vector3()
      if (dAngle > 1e-6) {
        const s = Math.sqrt(1 - dq.w * dq.w)
        if (s > 1e-6) {
          dRot.set(dq.x / s, dq.y / s, dq.z / s).multiplyScalar(dAngle / (2 * delta))
        }
      }

      J[0][j] = dPos.x
      J[1][j] = dPos.y
      J[2][j] = dPos.z
      J[3][j] = dRot.x
      J[4][j] = dRot.y
      J[5][j] = dRot.z
    }

    // 7. Solve using Damped Least Squares: (J^T * J + lambda^2 * I) * dq = J^T * e
    const JTJ = Array.from({ length: 6 }, () => new Array(6).fill(0))
    const JTe = new Array(6).fill(0)

    for (let r = 0; r < 6; r++) {
      // JTe calculation
      let sumJTe = 0
      for (let k = 0; k < 6; k++) {
        sumJTe += J[k][r] * e[k]
      }
      JTe[r] = sumJTe

      // JTJ calculation
      for (let c = 0; c < 6; c++) {
        let sumJTJ = 0
        for (let k = 0; k < 6; k++) {
          sumJTJ += J[k][r] * J[k][c]
        }
        JTJ[r][c] = sumJTJ + (r === c ? damping * damping : 0)
      }
    }

    let dq = solveLinearSystem(JTJ, JTe)

    // Check for NaN or Infinity in linear solver results
    if (dq.some((val) => isNaN(val) || !isFinite(val))) {
      // Fallback to stable Jacobian Transpose method
      const alpha = 0.05 // safe step size
      dq = new Array(6).fill(0)
      for (let j = 0; j < 6; j++) {
        let sum = 0
        for (let k = 0; k < 6; k++) {
          sum += J[k][j] * e[k]
        }
        dq[j] = alpha * sum
      }
    }

    // 8. Update state and enforce joint limits
    for (let j = 0; j < 6; j++) {
      // Additional safety check to prevent adding NaN
      const deltaQ = isNaN(dq[j]) || !isFinite(dq[j]) ? 0 : dq[j]
      q[j] += deltaQ
      q[j] = Math.max(JOINT_LIMITS[j].minRad, Math.min(JOINT_LIMITS[j].maxRad, q[j]))
    }
  }

  // Restore the original joint angles of the scene robot
  jointNames.forEach((name, idx) => {
    robotObj.joints[name].setJointValue(backupAngles[idx])
  })
  robotObj.updateMatrixWorld(true)

  // Limit joint angle change per frame (velocity clamp) to prevent sudden jumps or twists
  const maxStepPerFrame = 8 // degrees
  const finalAngles = q.map((rad, idx) => {
    const deg = (rad * 180) / Math.PI
    const prevDeg = currentAngles[idx]

    let diff = deg - prevDeg
    // Normalize diff just in case
    if (diff > 180) diff -= 360
    if (diff < -180) diff += 360

    const clampedDiff = Math.max(-maxStepPerFrame, Math.min(maxStepPerFrame, diff))
    const finalDeg = prevDeg + clampedDiff

    // Keep within hard joint limits
    const limit = JOINT_LIMITS[idx]
    const minDeg = (limit.minRad * 180) / Math.PI
    const maxDeg = (limit.maxRad * 180) / Math.PI

    return Math.round(Math.max(minDeg, Math.min(maxDeg, finalDeg)) * 10) / 10
  }) as JointAngles

  return finalAngles
}
