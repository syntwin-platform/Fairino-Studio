import { TCPPose } from '../types/robot.types'
import { defaultRobotRuntimeConfig, RobotRuntimeConfig } from '../types/backendDevice'

type MoveLRunner = (tcpPose: TCPPose, speed: number, signal: AbortSignal) => Promise<void>

let moveLRunner: MoveLRunner | null = null
let robotRuntimeConfig: RobotRuntimeConfig = defaultRobotRuntimeConfig

export function setRobotRuntimeConfig(config: RobotRuntimeConfig): void {
  robotRuntimeConfig = config
}

export function getRobotRuntimeConfig(): RobotRuntimeConfig {
  return robotRuntimeConfig
}

export function registerMoveLRunner(runner: MoveLRunner): () => void {
  moveLRunner = runner

  return () => {
    if (moveLRunner === runner) {
      moveLRunner = null
    }
  }
}

export async function runMoveL(
  tcpPose: TCPPose,
  speed: number,
  signal: AbortSignal
): Promise<void> {
  if (!moveLRunner) {
    throw new Error('Robot 3D is not ready for MoveL')
  }

  await moveLRunner(tcpPose, speed, signal)
}
