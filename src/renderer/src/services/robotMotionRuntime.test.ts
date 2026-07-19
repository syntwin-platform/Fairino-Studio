import { describe, expect, it } from 'vitest'
import type { JointAngles, TCPPose } from '../types/robot.types'
import { defaultRobotRuntimeConfig } from '../types/backendDevice'
import {
  getRobotRuntimeConfig,
  prepareMoveLForRobot,
  registerMoveLPlannerForRobot,
  setRobotRuntimeConfig
} from './robotMotionRuntime'

const targetPose: TCPPose = {
  x: 100,
  y: 200,
  z: 300,
  rx: 0,
  ry: 90,
  rz: 0
}

const startAngles: JointAngles = [0, 0, 0, 0, 0, 0]

describe('MoveL planner registry', () => {
  it('prepares and clones a registered robot trajectory', async () => {
    let receivedStartAngles: JointAngles | null = null

    const unregister = registerMoveLPlannerForRobot(
      'robot-planner-1',
      async (_pose, _speed, plannerStartAngles) => {
        receivedStartAngles = plannerStartAngles

        return {
          keyframes: [
            [0, 0, 0, 0, 0, 0],
            [10, 20, 30, 40, 50, 60]
          ],
          waypointCount: 1,
          planningDurationMs: 25
        }
      }
    )

    try {
      const trajectory = await prepareMoveLForRobot(
        'robot-planner-1',
        targetPose,
        30,
        startAngles,
        new AbortController().signal
      )

      expect(receivedStartAngles).toEqual(startAngles)
      expect(receivedStartAngles).not.toBe(startAngles)
      expect(trajectory.waypointCount).toBe(1)
      expect(trajectory.keyframes).toEqual([
        [0, 0, 0, 0, 0, 0],
        [10, 20, 30, 40, 50, 60]
      ])
    } finally {
      unregister()
    }
  })

  it('rejects a trajectory with inconsistent waypoint count', async () => {
    const unregister = registerMoveLPlannerForRobot('robot-planner-invalid', async () => ({
      keyframes: [
        [0, 0, 0, 0, 0, 0],
        [1, 2, 3, 4, 5, 6]
      ],
      waypointCount: 2,
      planningDurationMs: 10
    }))

    try {
      await expect(
        prepareMoveLForRobot(
          'robot-planner-invalid',
          targetPose,
          30,
          startAngles,
          new AbortController().signal
        )
      ).rejects.toThrow(/waypointCount must equal/i)
    } finally {
      unregister()
    }
  })

  it('removes the planner when unregister is called', async () => {
    const unregister = registerMoveLPlannerForRobot('robot-planner-removed', async () => ({
      keyframes: [
        [0, 0, 0, 0, 0, 0],
        [1, 1, 1, 1, 1, 1]
      ],
      waypointCount: 1,
      planningDurationMs: 1
    }))

    unregister()

    await expect(
      prepareMoveLForRobot(
        'robot-planner-removed',
        targetPose,
        30,
        startAngles,
        new AbortController().signal
      )
    ).rejects.toThrow(/not ready for MoveL planning/i)
  })

  it('uses recorded trace joints without invoking the generic IK planner', async () => {
    const targetAngles: JointAngles = [1, -2, 3, -4, 5, -6]

    const trajectory = await prepareMoveLForRobot(
      'recorded-trace-robot',
      targetPose,
      30,
      startAngles,
      new AbortController().signal,
      {
        recordedTargetAngles: targetAngles,
        segmentDurationMs: 42,
        trace: { groupId: 'trace-a', sampleIndex: 1, sampleCount: 2 }
      }
    )

    expect(trajectory).toMatchObject({
      keyframes: [startAngles, targetAngles],
      waypointCount: 1,
      durationMs: 42,
      source: 'recorded-trace',
      trace: { groupId: 'trace-a', sampleIndex: 1, sampleCount: 2 }
    })
  })
})

describe('robot runtime config registry', () => {
  it('keeps a separate MoveL policy for every robot', () => {
    try {
      setRobotRuntimeConfig({
        ...defaultRobotRuntimeConfig,
        robotId: 'runtime-policy-robot-a',
        motionPolicy: {
          ...defaultRobotRuntimeConfig.motionPolicy,
          moveL: {
            ...defaultRobotRuntimeConfig.motionPolicy.moveL,
            maxRotationDeg: 90
          }
        }
      })

      setRobotRuntimeConfig({
        ...defaultRobotRuntimeConfig,
        robotId: 'runtime-policy-robot-b',
        motionPolicy: {
          ...defaultRobotRuntimeConfig.motionPolicy,
          moveL: {
            ...defaultRobotRuntimeConfig.motionPolicy.moveL,
            maxRotationDeg: 150
          }
        }
      })

      expect(
        getRobotRuntimeConfig('runtime-policy-robot-a').motionPolicy.moveL.maxRotationDeg
      ).toBe(90)
      expect(
        getRobotRuntimeConfig('runtime-policy-robot-b').motionPolicy.moveL.maxRotationDeg
      ).toBe(150)
      expect(
        getRobotRuntimeConfig('runtime-policy-robot-missing').motionPolicy.moveL.maxRotationDeg
      ).toBe(180)
    } finally {
      setRobotRuntimeConfig(defaultRobotRuntimeConfig)
    }
  })
})
