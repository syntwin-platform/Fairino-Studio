import { TCPPose } from '../types/robot.types'

type MoveLRunner = (
  tcpPose: TCPPose,
  speed: number,
  signal: AbortSignal
) => Promise<void>

let moveLRunner: MoveLRunner | null = null

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