import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackendDeviceContractError,
  BackendDeviceRequestError,
  parseDeviceFactoryRunArmResponse,
  parseDeviceFactoryRunProgramArtifactResponse,
  postFactoryRunArmed
} from './backendDeviceClient'

afterEach(() => {
  vi.unstubAllGlobals()
})

function validArmResponse(): Record<string, unknown> {
  return {
    factoryRunId: 'run-1',
    targetId: 'target-1',
    commandId: 'command-1',
    robotId: 'robot-1',
    isReady: true,
    status: 'Running',
    scheduledStartAtUtc: '2026-07-12T04:00:00.000Z',
    expectedParticipantCount: 6,
    stepDurationsMs: [1000, 250, 1200]
  }
}

describe('parseDeviceFactoryRunArmResponse', () => {
  it('accepts and copies a valid response', () => {
    const source = validArmResponse()
    const result = parseDeviceFactoryRunArmResponse(source)

    expect(result.expectedParticipantCount).toBe(6)
    expect(result.stepDurationsMs).toEqual([1000, 250, 1200])
    expect(result.stepDurationsMs).not.toBe(source.stepDurationsMs)
  })

  it('rejects a backend response without expectedParticipantCount', () => {
    const source = validArmResponse()
    delete source.expectedParticipantCount

    expect(() => parseDeviceFactoryRunArmResponse(source)).toThrow(BackendDeviceContractError)
    expect(() => parseDeviceFactoryRunArmResponse(source)).toThrow(/positive integer/i)
  })

  it('requires a start timestamp when the barrier is ready', () => {
    const source = validArmResponse()
    source.scheduledStartAtUtc = null

    expect(() => parseDeviceFactoryRunArmResponse(source)).toThrow(
      /scheduledStartAtUtc is required/i
    )
  })

  it('rejects negative or fractional step durations', () => {
    const negative = validArmResponse()
    negative.stepDurationsMs = [100, -1]

    const fractional = validArmResponse()
    fractional.stepDurationsMs = [100, 1.5]

    expect(() => parseDeviceFactoryRunArmResponse(negative)).toThrow(/non-negative integers/i)
    expect(() => parseDeviceFactoryRunArmResponse(fractional)).toThrow(/non-negative integers/i)
  })
})

describe('parseDeviceFactoryRunProgramArtifactResponse', () => {
  it('accepts and sorts a valid shared program artifact', () => {
    const result = parseDeviceFactoryRunProgramArtifactResponse({
      factoryRunId: 'run-artifact',
      targetId: 'target-artifact',
      factoryRunProgramId: 'program-artifact',
      contractVersion: 1,
      compiledProgramHash: 'ABC123',
      programName: 'large-program',
      steps: [
        { orderIndex: 2, stepType: 'Comment', payload: {} },
        { orderIndex: 1, stepType: 'Comment', payload: {} }
      ]
    })

    expect(result.steps.map((step) => step.orderIndex)).toEqual([1, 2])
  })

  it('rejects unsupported versions and duplicate step indexes', () => {
    const baseArtifact = {
      factoryRunId: 'run-artifact',
      targetId: 'target-artifact',
      factoryRunProgramId: 'program-artifact',
      contractVersion: 1,
      compiledProgramHash: 'ABC123',
      programName: 'large-program',
      steps: [
        { orderIndex: 1, stepType: 'Comment', payload: {} },
        { orderIndex: 1, stepType: 'Comment', payload: {} }
      ]
    }

    expect(() =>
      parseDeviceFactoryRunProgramArtifactResponse({
        ...baseArtifact,
        contractVersion: 2
      })
    ).toThrow(/contractVersion must be 1/i)
    expect(() => parseDeviceFactoryRunProgramArtifactResponse(baseArtifact)).toThrow(
      /duplicate orderIndex/i
    )
  })
})

describe('postFactoryRunArmed', () => {
  it('preserves the structured retry contract returned by the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: 'Factory run barrier is busy. Please retry the arm request.',
            errorCode: 'factory_run_arm_busy',
            retryable: true,
            retryAfterMs: 250
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      )
    )

    const request = postFactoryRunArmed(
      {
        enabled: true,
        backendUrl: 'http://localhost:5200',
        robotId: 'robot-1',
        deviceSecret: 'secret',
        heartbeatIntervalMs: 3000,
        telemetryIntervalMs: 250,
        commandPollIntervalMs: 250
      },
      {
        factoryRunId: 'run-1',
        targetId: 'target-1',
        commandId: 'command-1',
        robotId: 'robot-1',
        receivedAtUtc: '2026-07-23T00:00:00.000Z',
        armedAtUtc: '2026-07-23T00:00:01.000Z',
        estimatedStepDurationsMs: [100, 200]
      },
      'token'
    )

    await expect(request).rejects.toMatchObject({
      status: 503,
      errorCode: 'factory_run_arm_busy',
      retryable: true,
      retryAfterMs: 250
    } satisfies Partial<BackendDeviceRequestError>)
  })
})
