import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { selectCollisionWarning, selectSafetyAlert, useSceneStore } from '../store/sceneStore'
import {
  beginCommandExecutionForRobot,
  finishCommandExecutionForRobot
} from './commandExecutionRuntime'
import { executionGroupRegistry } from './safety/executionGroupRegistry'
import { safetyGroupRegistry } from './safety/safetyGroupRegistry'
import {
  RobotMotionBlockedError,
  clearRobotSafetyContact,
  latchRobotFault,
  removeRobotSafetyState,
  reportRobotSafetyContact,
  resetRobotFault,
  throwIfRobotMotionBlocked
} from './robotFaultRuntime'

describe('robotFaultRuntime', () => {
  function clearTestRobotSafetyState(): void {
    const store = useSceneStore.getState()
    store.clearRobotSafetyState('robot-a')
    store.clearRobotSafetyState('robot-b')
    store.clearScene()
  }

  beforeEach(() => {
    safetyGroupRegistry.clear()
    executionGroupRegistry.clear()
    clearTestRobotSafetyState()
  })

  afterEach(() => {
    finishCommandExecutionForRobot('robot-a', 'command-a')
    finishCommandExecutionForRobot('robot-b', 'command-b')
    safetyGroupRegistry.clear()
    executionGroupRegistry.clear()
    clearTestRobotSafetyState()
  })

  it('stops both directly involved robots without stopping an unrelated robot', () => {
    const robotASignal = beginCommandExecutionForRobot('robot-a', 'command-a')
    const robotBSignal = beginCommandExecutionForRobot('robot-b', 'command-b')
    const robotCSignal = beginCommandExecutionForRobot('robot-c', 'command-c')

    try {
      reportRobotSafetyContact('robot-a', {
        level: 'collision',
        kind: 'robot',
        counterpartRobotIds: ['robot-b'],
        message: 'Robot A collided with robot B.'
      })

      expect(robotASignal.aborted).toBe(true)
      expect(robotBSignal.aborted).toBe(true)
      expect(robotCSignal.aborted).toBe(false)
      expect(useSceneStore.getState().robotFaultsById['robot-a']?.kind).toBe('collision')
      expect(useSceneStore.getState().robotFaultsById['robot-b']?.kind).toBe('collision')
      expect(useSceneStore.getState().robotFaultsById['robot-c']).toBeUndefined()
    } finally {
      finishCommandExecutionForRobot('robot-c', 'command-c')
      useSceneStore.getState().clearRobotSafetyState('robot-c')
    }
  })

  it('stops and blocks only the robot that reports a collision', () => {
    const robotASignal = beginCommandExecutionForRobot('robot-a', 'command-a')
    const robotBSignal = beginCommandExecutionForRobot('robot-b', 'command-b')

    reportRobotSafetyContact('robot-a', {
      level: 'collision',
      kind: 'obstacle',
      objectIds: ['fixture-1'],
      message: 'Robot A touched fixture 1.'
    })

    expect(robotASignal.aborted).toBe(true)
    expect(robotBSignal.aborted).toBe(false)
    expect(() => throwIfRobotMotionBlocked('robot-a')).toThrow(RobotMotionBlockedError)
    expect(() => throwIfRobotMotionBlocked('robot-b')).not.toThrow()
    expect(useSceneStore.getState().robotFaultsById['robot-b']).toBeUndefined()
  })

  it.each(['ground', 'self', 'obstacle'] as const)(
    'keeps a %s collision stop-set isolated to the affected robot',
    (kind) => {
      const robotASignal = beginCommandExecutionForRobot('robot-a', 'command-a')
      const robotBSignal = beginCommandExecutionForRobot('robot-b', 'command-b')

      reportRobotSafetyContact('robot-a', {
        level: 'collision',
        kind,
        objectIds: kind === 'obstacle' ? ['fixture-1'] : [],
        message: `Robot A reported a ${kind} collision.`
      })

      expect(robotASignal.aborted).toBe(true)
      expect(robotBSignal.aborted).toBe(false)
      expect(useSceneStore.getState().robotFaultsById['robot-a']?.kind).toBe('collision')
      expect(useSceneStore.getState().robotFaultsById['robot-b']).toBeUndefined()
    }
  )

  it('keeps a collision fault latched after physical contact clears', () => {
    reportRobotSafetyContact('robot-a', {
      level: 'collision',
      kind: 'self',
      message: 'Robot A self-collision.'
    })

    clearRobotSafetyContact('robot-a')

    expect(useSceneStore.getState().robotContactsById['robot-a']).toBeUndefined()
    expect(useSceneStore.getState().robotFaultsById['robot-a']?.latched).toBe(true)
    expect(selectCollisionWarning(useSceneStore.getState())).toBe(false)
    expect(selectSafetyAlert(useSceneStore.getState())).toBe(true)
    expect(() => throwIfRobotMotionBlocked('robot-a')).toThrow(RobotMotionBlockedError)
  })

  it('atomically restores motion eligibility after the collision engine validates a clear', () => {
    reportRobotSafetyContact('robot-a', {
      level: 'collision',
      kind: 'robot',
      counterpartRobotIds: ['robot-b'],
      message: 'Robot A collided with robot B.'
    })

    clearRobotSafetyContact('robot-a', { resetResolvedCollisionFault: true })

    expect(useSceneStore.getState().robotContactsById['robot-a']).toBeUndefined()
    expect(useSceneStore.getState().robotFaultsById['robot-a']).toBeUndefined()
    expect(() => throwIfRobotMotionBlocked('robot-a')).not.toThrow()
  })

  it('requires safety validation and a cleared collision before reset', () => {
    reportRobotSafetyContact('robot-a', {
      level: 'collision',
      kind: 'ground',
      message: 'Robot A crossed the ground plane.'
    })

    expect(resetRobotFault('robot-a', { safetyValidated: false })).toBe(false)
    expect(resetRobotFault('robot-a', { safetyValidated: true })).toBe(false)

    clearRobotSafetyContact('robot-a')

    expect(resetRobotFault('robot-a', { safetyValidated: true })).toBe(true)
    expect(useSceneStore.getState().robotFaultsById['robot-a']).toBeUndefined()
  })

  it('treats proximity as a warning without blocking motion', () => {
    const robotASignal = beginCommandExecutionForRobot('robot-a', 'command-a')

    reportRobotSafetyContact('robot-a', {
      level: 'proximity',
      kind: 'obstacle',
      objectIds: ['fixture-1'],
      message: 'Robot A is near fixture 1.'
    })

    expect(robotASignal.aborted).toBe(false)
    expect(useSceneStore.getState().robotFaultsById['robot-a']).toBeUndefined()
    expect(selectCollisionWarning(useSceneStore.getState())).toBe(false)
    expect(() => throwIfRobotMotionBlocked('robot-a')).not.toThrow()
  })

  it('records a Training collision without cancelling or latching a runtime fault', () => {
    const robotASignal = beginCommandExecutionForRobot('robot-a', 'command-a')

    reportRobotSafetyContact(
      'robot-a',
      {
        level: 'collision',
        kind: 'ground',
        message: 'Offline Training preview intersects the ground.'
      },
      { triggerSafetyAction: false }
    )

    expect(robotASignal.aborted).toBe(false)
    expect(useSceneStore.getState().robotContactsById['robot-a']?.level).toBe('collision')
    expect(useSceneStore.getState().robotFaultsById['robot-a']).toBeUndefined()
    expect(selectCollisionWarning(useSceneStore.getState())).toBe(true)
  })

  it('clears one robot without changing another robot fault', () => {
    latchRobotFault('robot-a', {
      kind: 'command',
      code: 'COMMAND_A_FAILED',
      message: 'Robot A failed.',
      cancelMotion: false
    })
    latchRobotFault('robot-b', {
      kind: 'timeout',
      code: 'COMMAND_B_TIMEOUT',
      message: 'Robot B timed out.',
      cancelMotion: false
    })

    expect(resetRobotFault('robot-b', { safetyValidated: true })).toBe(true)
    expect(useSceneStore.getState().robotFaultsById['robot-a']?.active).toBe(true)
    expect(useSceneStore.getState().robotFaultsById['robot-b']).toBeUndefined()

    removeRobotSafetyState('robot-a')
    expect(useSceneStore.getState().robotFaultsById['robot-a']).toBeUndefined()
  })

  it('does not silently clear a latched fault when scene objects are cleared', () => {
    latchRobotFault('robot-a', {
      kind: 'safety-policy',
      code: 'SAFETY_POLICY_BLOCKED',
      message: 'Robot A requires an explicit reset.',
      cancelMotion: false
    })

    useSceneStore.getState().clearScene()

    expect(useSceneStore.getState().robotFaultsById['robot-a']?.latched).toBe(true)
  })
})
