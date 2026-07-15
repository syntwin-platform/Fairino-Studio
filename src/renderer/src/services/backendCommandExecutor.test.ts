import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSceneStore } from '../store/sceneStore'
import { executeBackendCommand } from './backendCommandExecutor'
import {
  beginCommandExecutionForRobot,
  finishCommandExecutionForRobot
} from './commandExecutionRuntime'

describe('backendCommandExecutor FactoryRun failure policy', () => {
  afterEach(() => {
    finishCommandExecutionForRobot('robot-a', 'command-a')
    finishCommandExecutionForRobot('robot-b', 'command-b')
    useSceneStore.getState().clearRobotSafetyState('robot-a')
    useSceneStore.getState().clearRobotSafetyState('robot-b')
  })

  it('does not cancel another participant when IsolateTarget fails during preparation', async () => {
    const survivorSignal = beginCommandExecutionForRobot('robot-b', 'command-b', 'run-isolated')

    await expect(
      executeBackendCommand({
        commandId: 'command-a',
        robotId: 'robot-a',
        commandType: 'RunProgram',
        createdAt: new Date().toISOString(),
        payload: {
          factoryRunId: 'run-isolated',
          targetId: 'target-a',
          syncMode: 'Barrier',
          failurePolicy: 'IsolateTarget',
          steps: [
            {
              orderIndex: 1,
              stepType: 'UnsupportedPreparationStep',
              payload: {}
            }
          ]
        }
      })
    ).rejects.toThrow(/unsupported runprogram step type during preparation/i)

    expect(survivorSignal.aborted).toBe(false)
  })

  it('runs ParallelIndependent without arm polling or synchronized barriers', async () => {
    const armFactoryRunCommand = vi.fn()
    const reportFactoryRunStarted = vi.fn().mockResolvedValue(undefined)

    await executeBackendCommand(
      {
        commandId: 'command-a',
        robotId: 'robot-a',
        commandType: 'RunProgram',
        createdAt: new Date().toISOString(),
        payload: {
          factoryRunId: 'run-independent',
          targetId: 'target-a',
          coordinationMode: 'ParallelIndependent',
          syncMode: 'Independent',
          failurePolicy: 'IsolateTarget',
          steps: [
            {
              orderIndex: 1,
              stepType: 'Comment',
              payload: {}
            }
          ]
        }
      },
      {
        armFactoryRunCommand,
        reportFactoryRunStarted
      }
    )

    expect(armFactoryRunCommand).not.toHaveBeenCalled()
    expect(reportFactoryRunStarted).toHaveBeenCalledOnce()
  })
})
