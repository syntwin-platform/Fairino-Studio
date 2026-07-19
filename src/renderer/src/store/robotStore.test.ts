import { afterEach, describe, expect, it } from 'vitest'
import { useRobotStore } from './robotStore'

describe('robotStore Cartesian trace actions', () => {
  afterEach(() => {
    useRobotStore.setState({
      steps: [],
      selectedStepId: null,
      cartesianInteractionMode: 'point',
      isIKMode: false
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
})
