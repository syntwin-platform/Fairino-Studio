import { describe, expect, it } from 'vitest'

import { toWorkflowStep } from './backendLuaWorkflowMapper'

describe('backendLuaWorkflowMapper', () => {
  it('maps an executable backend step without changing its semantics', () => {
    expect(
      toWorkflowStep({
        orderIndex: 1,
        stepType: 'WaitMs',
        label: 'Wait',
        payload: { delayMs: 250 }
      })
    ).toMatchObject({
      type: 'WaitMs',
      delayMs: 250
    })
  })

  it('does not silently convert an unsupported LUA command into a comment', () => {
    expect(
      toWorkflowStep({
        orderIndex: 2,
        stepType: 'CustomCommand',
        label: 'Unknown command',
        payload: { raw: 'UnknownRobotCommand()' }
      })
    ).toBeNull()
  })

  it('restores recorded trace joints and timing from backend payload', () => {
    expect(
      toWorkflowStep({
        orderIndex: 2,
        stepType: 'MoveL',
        label: 'Trace point 1',
        payload: {
          tcpPose: { x: 100, y: 200, z: 300, rx: 0, ry: 90, rz: 0 },
          recordedJointAngles: [1, -19, 31, -39, -89, 1],
          trace: {
            groupId: 'trace-a',
            sampleIndex: 1,
            sampleCount: 2,
            segmentDurationMs: 42
          }
        }
      })
    ).toMatchObject({
      type: 'MoveL',
      jointAngles: [1, -19, 31, -39, -89, 1],
      trace: {
        groupId: 'trace-a',
        sampleIndex: 1,
        sampleCount: 2,
        segmentDurationMs: 42
      }
    })
  })
})
