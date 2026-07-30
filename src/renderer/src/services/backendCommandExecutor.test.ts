import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSceneStore } from '../store/sceneStore'
import {
  clearFactoryRunProgramArtifactCache,
  executeBackendCommand,
  isRetryableFactoryRunArmError
} from './backendCommandExecutor'
import { BackendDeviceRequestError } from './backendDeviceClient'
import {
  beginCommandExecutionForRobot,
  cancelActiveCommandForRobot,
  finishCommandExecutionForRobot
} from './commandExecutionRuntime'

describe('backendCommandExecutor FactoryRun failure policy', () => {
  afterEach(() => {
    clearFactoryRunProgramArtifactCache()
    finishCommandExecutionForRobot('robot-a', 'command-a')
    finishCommandExecutionForRobot('robot-b', 'command-b')
    useSceneStore.getState().clearRobotSafetyState('robot-a')
    useSceneStore.getState().clearRobotSafetyState('robot-b')
  })

  it('retries the structured transient arm contention response', () => {
    const error = new BackendDeviceRequestError(
      503,
      'HTTP 503: Factory run barrier is busy. Please retry the arm request.',
      'factory_run_arm_busy',
      true,
      250
    )

    expect(isRetryableFactoryRunArmError(error)).toBe(true)
  })

  it('keeps compatibility with the legacy HTTP 400 busy response', () => {
    const error = new BackendDeviceRequestError(
      400,
      'HTTP 400: Factory run barrier is busy. Please retry the arm request.'
    )

    expect(isRetryableFactoryRunArmError(error)).toBe(true)
  })

  it('does not retry validation or unrelated service errors', () => {
    const validationError = new BackendDeviceRequestError(
      400,
      'HTTP 400: estimatedStepDurationsMs is invalid.'
    )
    const unrelatedServiceError = new BackendDeviceRequestError(
      503,
      'HTTP 503: Database unavailable.'
    )

    expect(isRetryableFactoryRunArmError(validationError)).toBe(false)
    expect(isRetryableFactoryRunArmError(unrelatedServiceError)).toBe(false)
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

  it('prefetches a shared artifact once and reuses it for RunProgram', async () => {
    const artifactReference = {
      contractVersion: 1,
      factoryRunProgramId: 'program-artifact',
      compiledProgramHash: 'ABC123'
    }
    const loadFactoryRunProgramArtifact = vi.fn().mockResolvedValue({
      factoryRunId: 'run-artifact',
      targetId: 'target-artifact',
      factoryRunProgramId: 'program-artifact',
      contractVersion: 1,
      compiledProgramHash: 'abc123',
      programName: 'large-program',
      steps: [
        {
          orderIndex: 1,
          stepType: 'Comment',
          payload: {}
        }
      ]
    })
    const reportFactoryRunStarted = vi.fn().mockResolvedValue(undefined)

    await executeBackendCommand(
      {
        commandId: 'prepare-artifact',
        robotId: 'robot-artifact',
        commandType: 'PrepareProgram',
        createdAt: new Date().toISOString(),
        payload: {
          factoryRunId: 'run-artifact',
          targetId: 'target-artifact',
          artifact: artifactReference
        }
      },
      { loadFactoryRunProgramArtifact }
    )

    await executeBackendCommand(
      {
        commandId: 'run-artifact',
        robotId: 'robot-artifact',
        commandType: 'RunProgram',
        createdAt: new Date().toISOString(),
        payload: {
          factoryRunId: 'run-artifact',
          targetId: 'target-artifact',
          coordinationMode: 'ParallelIndependent',
          syncMode: 'Independent',
          failurePolicy: 'IsolateTarget',
          artifact: artifactReference
        }
      },
      {
        loadFactoryRunProgramArtifact,
        reportFactoryRunStarted
      }
    )

    expect(loadFactoryRunProgramArtifact).toHaveBeenCalledOnce()
    expect(reportFactoryRunStarted).toHaveBeenCalledOnce()
  })

  it('loads one 1000-step artifact for 30 parallel preparation commands', async () => {
    const participantCount = 30
    const stepCount = 1000
    const artifactReference = {
      contractVersion: 1,
      factoryRunProgramId: 'program-artifact-scale',
      compiledProgramHash: 'SCALE1000'
    }
    const sharedSteps = Array.from({ length: stepCount }, (_, index) => ({
      orderIndex: index + 1,
      stepType: 'Comment',
      payload: {}
    }))
    const loadFactoryRunProgramArtifact = vi.fn(async (factoryRunId: string, targetId: string) => ({
      factoryRunId,
      targetId,
      factoryRunProgramId: artifactReference.factoryRunProgramId,
      contractVersion: artifactReference.contractVersion,
      compiledProgramHash: artifactReference.compiledProgramHash.toLowerCase(),
      programName: 'scale-program',
      steps: sharedSteps
    }))

    await Promise.all(
      Array.from({ length: participantCount }, (_, index) =>
        executeBackendCommand(
          {
            commandId: `prepare-artifact-scale-${index}`,
            robotId: `robot-artifact-scale-${index}`,
            commandType: 'PrepareProgram',
            createdAt: new Date().toISOString(),
            payload: {
              factoryRunId: 'run-artifact-scale',
              targetId: `target-artifact-scale-${index}`,
              artifact: artifactReference
            }
          },
          { loadFactoryRunProgramArtifact }
        )
      )
    )

    expect(loadFactoryRunProgramArtifact).toHaveBeenCalledOnce()
    expect(loadFactoryRunProgramArtifact).toHaveBeenCalledWith(
      'run-artifact-scale',
      expect.stringMatching(/^target-artifact-scale-\d+$/),
      artifactReference,
      expect.any(AbortSignal)
    )
  })

  it('keeps the shared artifact request alive when one waiting robot is cancelled', async () => {
    const artifactReference = {
      contractVersion: 1,
      factoryRunProgramId: 'program-artifact-cancellation',
      compiledProgramHash: 'CANCELSAFE'
    }
    let resolveArtifact:
      | ((value: {
          factoryRunId: string
          targetId: string
          factoryRunProgramId: string
          contractVersion: number
          compiledProgramHash: string
          programName: string
          steps: Array<{ orderIndex: number; stepType: string; payload: object }>
        }) => void)
      | undefined
    let sharedLoadSignal: AbortSignal | undefined

    const loadFactoryRunProgramArtifact = vi.fn(
      (
        factoryRunId: string,
        targetId: string,
        _artifact: typeof artifactReference,
        signal: AbortSignal
      ) => {
        sharedLoadSignal = signal

        return new Promise<{
          factoryRunId: string
          targetId: string
          factoryRunProgramId: string
          contractVersion: number
          compiledProgramHash: string
          programName: string
          steps: Array<{ orderIndex: number; stepType: string; payload: object }>
        }>((resolve) => {
          resolveArtifact = resolve
        }).then((artifact) => ({
          ...artifact,
          factoryRunId,
          targetId
        }))
      }
    )

    const firstResult = executeBackendCommand(
      {
        commandId: 'prepare-cancelled-consumer',
        robotId: 'robot-a',
        commandType: 'PrepareProgram',
        createdAt: new Date().toISOString(),
        payload: {
          factoryRunId: 'run-artifact-cancellation',
          targetId: 'target-a',
          artifact: artifactReference
        }
      },
      { loadFactoryRunProgramArtifact }
    ).then(
      () => null,
      (error: unknown) => error
    )

    const survivingPreparation = executeBackendCommand(
      {
        commandId: 'prepare-surviving-consumer',
        robotId: 'robot-b',
        commandType: 'PrepareProgram',
        createdAt: new Date().toISOString(),
        payload: {
          factoryRunId: 'run-artifact-cancellation',
          targetId: 'target-b',
          artifact: artifactReference
        }
      },
      { loadFactoryRunProgramArtifact }
    )

    cancelActiveCommandForRobot('robot-a', 'Cancel only the first artifact consumer.')

    expect(sharedLoadSignal?.aborted).toBe(false)

    resolveArtifact?.({
      factoryRunId: 'run-artifact-cancellation',
      targetId: 'target-a',
      factoryRunProgramId: artifactReference.factoryRunProgramId,
      contractVersion: artifactReference.contractVersion,
      compiledProgramHash: artifactReference.compiledProgramHash.toLowerCase(),
      programName: 'cancellation-safe-program',
      steps: [{ orderIndex: 1, stepType: 'Comment', payload: {} }]
    })

    await expect(survivingPreparation).resolves.toBeUndefined()

    const cancelledError = await firstResult
    expect(cancelledError).toBeInstanceOf(Error)
    expect((cancelledError as Error).message).toMatch(/cancel only the first artifact consumer/i)
    expect(loadFactoryRunProgramArtifact).toHaveBeenCalledOnce()
  })

  it.each([6, 20, 30])(
    'registers %i synchronized targets while sharing one barrier readiness poller',
    async (participantCount) => {
      const registeredTargetIds = new Set<string>()
      let scheduledStartAtUtc: string | null = null

      const armFactoryRunCommand = vi.fn(
        async (payload: {
          targetId: string
        }): Promise<{
          isReady: boolean
          scheduledStartAtUtc: string | null
          expectedParticipantCount: number
          stepDurationsMs: number[]
        }> => {
          registeredTargetIds.add(payload.targetId)

          if (registeredTargetIds.size === participantCount && !scheduledStartAtUtc) {
            scheduledStartAtUtc = new Date(Date.now() + 500).toISOString()
          }

          return {
            isReady: scheduledStartAtUtc !== null,
            scheduledStartAtUtc,
            expectedParticipantCount: participantCount,
            stepDurationsMs: [0]
          }
        }
      )
      const reportFactoryRunStarted = vi.fn().mockResolvedValue(undefined)

      await Promise.all(
        Array.from({ length: participantCount }, (_, index) =>
          executeBackendCommand(
            {
              commandId: `command-scale-${index}`,
              robotId: `robot-scale-${index}`,
              commandType: 'RunProgram',
              createdAt: new Date().toISOString(),
              payload: {
                factoryRunId: `run-scale-${participantCount}`,
                targetId: `target-scale-${index}`,
                coordinationMode: 'Synchronized',
                syncMode: 'Barrier',
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
        )
      )

      expect(registeredTargetIds.size).toBe(participantCount)
      expect(armFactoryRunCommand.mock.calls.length).toBeLessThanOrEqual(participantCount + 2)
      expect(reportFactoryRunStarted).toHaveBeenCalledTimes(participantCount)
    }
  )
})
