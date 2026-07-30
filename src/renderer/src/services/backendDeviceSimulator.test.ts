import { afterEach, describe, expect, it } from 'vitest'
import { useRobotStore } from '../store/robotStore'
import { useSceneStore } from '../store/sceneStore'
import type { BackendSimulatorConfig } from '../types/backendDevice'
import type { WorkflowStep } from '../types/robot.types'
import { buildTelemetryFromStores, buildTelemetryRuntimeStatus } from './backendDeviceSimulator'

const robotId = '77497ee1-6ad6-44c6-8c59-6f6fa3093f54'

const config: BackendSimulatorConfig = {
  enabled: true,
  backendUrl: 'https://example.run.app',
  robotId,
  deviceSecret: 'device-secret',
  heartbeatIntervalMs: 3000,
  telemetryIntervalMs: 250,
  commandPollIntervalMs: 1000
}

const initialRobotState = useRobotStore.getInitialState()
const initialSceneState = useSceneStore.getInitialState()

afterEach(() => {
  useRobotStore.setState(initialRobotState, true)
  useSceneStore.setState(initialSceneState, true)
})

describe('buildTelemetryFromStores', () => {
  it('adds sequence, execution and selected-robot I/O without temperature', () => {
    useRobotStore.setState({
      selectedRobotId: robotId,
      jointAnglesByRobotId: {
        [robotId]: [10, 20, 30, 40, 50, 60]
      },
      tcpPoseByRobotId: {
        [robotId]: { x: 100, y: 200, z: 300, rx: 1, ry: 2, rz: 3 }
      },
      robotExecutionById: {
        [robotId]: {
          isPlaying: true,
          currentStepIndex: 1,
          startedAt: '2026-07-29T01:00:00Z'
        }
      },
      steps: [
        { id: 'step-1' },
        { id: 'step-2' },
        { id: 'step-3' },
        { id: 'step-4' }
      ] as WorkflowStep[],
      cabinetDigitalOutputs: { 0: 1, 1: 0 },
      toolDigitalOutputs: { 0: 1 },
      gripperState: 'closed'
    })

    const telemetry = buildTelemetryFromStores(config, 42)

    expect(telemetry.sequenceNumber).toBe(42)
    expect(telemetry.jointAngles).toEqual([10, 20, 30, 40, 50, 60])
    expect(telemetry.io).toEqual({
      cabinetDigitalOutputs: { 0: true, 1: false },
      toolDigitalOutputs: { 0: true },
      gripperState: 'closed'
    })
    expect(telemetry.execution).toMatchObject({
      state: 'Running',
      currentStepIndex: 1,
      totalSteps: 4,
      progressPercent: 50,
      startedAt: '2026-07-29T01:00:00Z'
    })
    expect(telemetry).not.toHaveProperty('temperature')
  })

  it('does not leak selected-robot I/O into another robot telemetry payload', () => {
    useRobotStore.setState({
      selectedRobotId: 'another-robot',
      cabinetDigitalOutputs: { 0: 1 },
      toolDigitalOutputs: { 1: 1 },
      gripperState: 'closed'
    })

    const telemetry = buildTelemetryFromStores(config, 7)

    expect(telemetry.io).toBeUndefined()
    expect(telemetry.execution?.totalSteps).toBeUndefined()
    expect(telemetry.execution?.progressPercent).toBeUndefined()
  })
})

describe('buildTelemetryRuntimeStatus', () => {
  it('captures the latest telemetry observability snapshot', () => {
    const telemetry = {
      ...buildTelemetryFromStores(config, 42),
      statusCode: 'RUNNING',
      collisionWarning: true
    }

    const status = buildTelemetryRuntimeStatus(telemetry, 18.456, undefined, '2026-07-29T02:00:00Z')

    expect(status).toMatchObject({
      isConnected: true,
      lastTelemetryAt: '2026-07-29T02:00:00Z',
      lastTelemetrySequenceNumber: 42,
      lastTelemetryRoundTripMs: 18.5,
      lastTelemetryStatusCode: 'RUNNING',
      lastCollisionWarning: true,
      lastExecutionSnapshot: telemetry.execution,
      lastError: undefined
    })
    expect(status.telemetrySamples).toEqual([
      {
        recordedAt: '2026-07-29T02:00:00Z',
        roundTripMs: 18.5,
        sequenceNumber: 42
      }
    ])
  })

  it('keeps only the 30 most recent latency samples', () => {
    const telemetry = buildTelemetryFromStores(config, 31)
    const telemetrySamples = Array.from({ length: 30 }, (_, index) => ({
      recordedAt: `2026-07-29T02:00:${String(index).padStart(2, '0')}Z`,
      roundTripMs: index,
      sequenceNumber: index + 1
    }))

    const status = buildTelemetryRuntimeStatus(
      telemetry,
      31,
      {
        isRunning: true,
        isConnected: true,
        telemetrySamples
      },
      '2026-07-29T02:01:00Z'
    )

    expect(status.telemetrySamples).toHaveLength(30)
    expect(status.telemetrySamples?.[0].sequenceNumber).toBe(2)
    expect(status.telemetrySamples?.at(-1)).toMatchObject({
      roundTripMs: 31,
      sequenceNumber: 31
    })
  })
})
