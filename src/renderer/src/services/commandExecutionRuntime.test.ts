import { describe, expect, it } from 'vitest'
import {
  beginCommandExecutionForRobot,
  cancelActiveCommandsForGroup,
  finishCommandExecutionForRobot
} from './commandExecutionRuntime'

describe('commandExecutionRuntime execution groups', () => {
  it('cancels only commands belonging to the requested FactoryRun group', () => {
    const runASignal = beginCommandExecutionForRobot('robot-a', 'command-a', 'run-1')
    const runBSignal = beginCommandExecutionForRobot('robot-b', 'command-b', 'run-1')
    const independentSignal = beginCommandExecutionForRobot('robot-c', 'command-c', 'run-2')

    try {
      expect(cancelActiveCommandsForGroup('run-1', 'group failed')).toBe(2)
      expect(runASignal.aborted).toBe(true)
      expect(runBSignal.aborted).toBe(true)
      expect(independentSignal.aborted).toBe(false)
    } finally {
      finishCommandExecutionForRobot('robot-a', 'command-a')
      finishCommandExecutionForRobot('robot-b', 'command-b')
      finishCommandExecutionForRobot('robot-c', 'command-c')
    }
  })
})
