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
})
