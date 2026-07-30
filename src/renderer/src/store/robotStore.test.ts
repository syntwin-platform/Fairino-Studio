import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_JOINT_ANGLES } from '../types/robot.types'
import { useRobotStore } from './robotStore'

describe('robotStore Cartesian trace actions', () => {
  afterEach(() => {
    useRobotStore.getState().clearAccountSession()
    useRobotStore.setState({
      steps: [],
      selectedStepId: null,
      cartesianInteractionMode: 'point',
      isIKMode: false,
      workspaceMode: 'factory',
      language: 'vi',
      projectName: 'coffee_machine_workflow'
    })
  })

  it('appends a trace atomically and selects its last step', () => {
    useRobotStore.getState().addSteps([
      {
        type: 'MoveJ',
        label: 'Trace approach',
        jointAngles: [0, 0, 0, 0, 0, 0],
        speed: 30,
        acc: 30
      },
      {
        type: 'MoveL',
        label: 'Trace point 1',
        tcpPose: { x: 10, y: 20, z: 30, rx: 0, ry: 0, rz: 0 },
        speed: 30,
        acc: 30
      }
    ])

    const state = useRobotStore.getState()
    expect(state.steps).toHaveLength(2)
    expect(new Set(state.steps.map((step) => step.id)).size).toBe(2)
    expect(state.selectedStepId).toBe(state.steps[1].id)
  })

  it('switches the Cartesian interaction without changing IK mode', () => {
    useRobotStore.setState({ isIKMode: true })
    useRobotStore.getState().setCartesianInteractionMode('trace')

    expect(useRobotStore.getState().cartesianInteractionMode).toBe('trace')
    expect(useRobotStore.getState().isIKMode).toBe(true)
  })

  it('clears the complete workflow and resets local simulation state', () => {
    useRobotStore.getState().addStep({
      type: 'WaitMs',
      label: 'Wait',
      delayMs: 100,
      speed: 30,
      acc: 30
    })
    useRobotStore.setState({ currentStepIndex: 1, isPlaying: true })

    useRobotStore.getState().clearSteps()

    const state = useRobotStore.getState()
    expect(state.steps).toEqual([])
    expect(state.selectedStepId).toBeNull()
    expect(state.currentStepIndex).toBe(0)
    expect(state.isPlaying).toBe(false)
  })

  it('clears account robot state while preserving local workspace preferences', () => {
    useRobotStore.setState({
      robots: [
        {
          id: 'robot-1',
          name: 'Account robot',
          model: 'FR5',
          status: 'Online',
          connectionType: 'HTTP'
        }
      ],
      selectedRobotId: 'robot-1',
      workspaceMode: 'train',
      language: 'en',
      projectName: 'local-project',
      robotRuntimeById: {
        'robot-1': {
          isRunning: true,
          isConnected: true,
          lastHeartbeatAt: '2026-07-29T00:00:00.000Z'
        }
      },
      robotExecutionById: {
        'robot-1': {
          isPlaying: true,
          currentStepIndex: 4
        }
      },
      jointAngles: [1, 2, 3, 4, 5, 6],
      jointAnglesByRobotId: {
        'robot-1': [1, 2, 3, 4, 5, 6]
      },
      tcpPose: { x: 1, y: 2, z: 3, rx: 4, ry: 5, rz: 6 },
      tcpPoseByRobotId: {
        'robot-1': { x: 1, y: 2, z: 3, rx: 4, ry: 5, rz: 6 }
      },
      isIKMode: true,
      isRobotPlacementMode: true,
      isPlaying: true,
      currentStepIndex: 4,
      selectedJointName: 'joint_2',
      cabinetDigitalOutputs: { 1: 1 },
      toolDigitalOutputs: { 2: 1 },
      gripperState: 'closed'
    })

    useRobotStore.getState().clearAccountSession()

    const state = useRobotStore.getState()
    expect(state.robots).toEqual([])
    expect(state.selectedRobotId).toBeNull()
    expect(state.robotRuntimeById).toEqual({})
    expect(state.robotExecutionById).toEqual({})
    expect(state.jointAnglesByRobotId).toEqual({})
    expect(state.tcpPoseByRobotId).toEqual({})
    expect(state.jointAngles).toEqual(DEFAULT_JOINT_ANGLES)
    expect(state.tcpPose).toEqual({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 })
    expect(state.isIKMode).toBe(false)
    expect(state.isRobotPlacementMode).toBe(false)
    expect(state.isPlaying).toBe(false)
    expect(state.currentStepIndex).toBe(0)
    expect(state.selectedJointName).toBeNull()
    expect(state.cabinetDigitalOutputs).toEqual({})
    expect(state.toolDigitalOutputs).toEqual({})
    expect(state.gripperState).toBe('open')

    expect(state.workspaceMode).toBe('train')
    expect(state.language).toBe('en')
    expect(state.projectName).toBe('local-project')
  })
})
