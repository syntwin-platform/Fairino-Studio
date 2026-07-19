import { describe, expect, it } from 'vitest'
import { generateLua } from './luaCodegen'
import type { WorkflowStep } from '../../types/robot.types'

describe('generateLua Cartesian trace compatibility', () => {
  it('exports trace metadata as ordinary MoveJ and MoveL commands', () => {
    const steps: WorkflowStep[] = [
      {
        id: 'approach',
        type: 'MoveJ',
        label: 'Trace approach',
        jointAngles: [0, -20, 30, -40, -90, 0],
        speed: 30,
        acc: 30,
        trace: { groupId: 'trace-1', sampleIndex: 0, sampleCount: 2, segmentDurationMs: 0 }
      },
      {
        id: 'path',
        type: 'MoveL',
        label: 'Trace point 1',
        tcpPose: { x: 100, y: 200, z: 300, rx: 0, ry: 90, rz: 0 },
        jointAngles: [1, -19, 31, -39, -89, 1],
        speed: 30,
        acc: 30,
        trace: {
          groupId: 'trace-1',
          sampleIndex: 1,
          sampleCount: 2,
          segmentDurationMs: 40
        }
      }
    ]

    const lua = generateLua(steps, 'trace_project')
    expect(lua).toContain('MoveJ({')
    expect(lua).toContain('MoveL({')
    expect(lua).toContain('-- @FAIROBOT_TRACE {"version":1,"groupId":"trace-1"')
    expect(lua).toContain('"jointAngles":[1,-19,31,-39,-89,1]')
  })
})
