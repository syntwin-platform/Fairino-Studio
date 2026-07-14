import { describe, expect, it } from 'vitest'
import { BackendDeviceContractError, parseDeviceFactoryRunArmResponse } from './backendDeviceClient'

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
