// Types for FaiRobot Studio
export type ProgrammingMode = 'normal' | 'advanced' | 'import'

export type RobotProgramSource = 'Studio' | 'ImportedLua' | 'BackendGenerated'
export type JointAngles = [number, number, number, number, number, number] // in degrees
export const DEFAULT_JOINT_ANGLES: JointAngles = [0, -58.5, 93.6, -149.6, -90.2, 0]
export interface TCPPose {
  x: number // mm
  y: number // mm
  z: number // mm
  rx: number // degrees
  ry: number // degrees
  rz: number // degrees
}

export type StepType =
  | 'MoveJ'
  | 'MoveL'
  | 'GripperOpen'
  | 'GripperClose'
  | 'SetDO'
  | 'WaitMs'
  | 'RotateJoint'
  | 'MoveTCP'
  | 'Comment'

export interface WorkflowStep {
  id: string
  type: StepType
  label: string
  // Motion parameters
  jointAngles?: JointAngles
  tcpPose?: TCPPose
  speed: number // 1-100%
  acc: number // 1-100%
  // IO parameters
  doIndex?: number
  doValue?: 0 | 1
  doType?: 'cabinet' | 'tool'
  // Delay parameters
  delayMs?: number
  // Low-code Scratch parameters
  jointIndex?: number // 1-6
  rotateMode?: 'absolute' | 'relative'
  angle?: number // degrees
  tcpAxis?: 'X' | 'Y' | 'Z'
  moveMode?: 'absolute' | 'relative'
  distance?: number // mm
  // Metadata
  comment?: string
}

export interface RobotModelConfig {
  name: string
  payload: number // kg
  reach: number // mm
  jointLimits: {
    min: JointAngles
    max: JointAngles
  }
}
