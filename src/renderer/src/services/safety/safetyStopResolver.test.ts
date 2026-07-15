import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ExecutionGroupRegistry } from './executionGroupRegistry'
import { SafetyGroupRegistry } from './safetyGroupRegistry'
import { executeSafetyStop, resolveSafetyStop } from './safetyStopResolver'

describe('safetyStopResolver', () => {
  let safetyGroups: SafetyGroupRegistry
  let executionGroups: ExecutionGroupRegistry

  beforeEach(() => {
    safetyGroups = new SafetyGroupRegistry()
    executionGroups = new ExecutionGroupRegistry()
  })

  it('stops both root robots in a robot-robot collision', () => {
    const resolution = resolveSafetyStop(
      {
        type: 'robot-robot',
        rootRobotIds: ['robot-a', 'robot-b'],
        stopScope: 'Robot'
      },
      {},
      safetyGroups,
      executionGroups
    )

    expect(resolution.stopRobotIds).toEqual(['robot-a', 'robot-b'])
    expect(resolution.causeByRobotId).toEqual({
      'robot-a': 'root-fault',
      'robot-b': 'root-fault'
    })
  })

  it('expands a root fault to its safety group only', () => {
    safetyGroups.setGroupMembers('cell-1', ['robot-a', 'robot-c'])

    const resolution = resolveSafetyStop(
      {
        type: 'robot-obstacle',
        rootRobotIds: ['robot-a'],
        stopScope: 'SafetyGroup'
      },
      {},
      safetyGroups,
      executionGroups
    )

    expect(resolution.stopRobotIds).toEqual(['robot-a', 'robot-c'])
    expect(resolution.safetyGroupRobotIds).toEqual(['robot-c'])
    expect(resolution.affectedSafetyGroupIds).toEqual(['cell-1'])
  })

  it('does not expand an IsolateTarget execution group', () => {
    safetyGroups.setGroupMembers('cell-1', ['robot-a', 'robot-c'])
    executionGroups.register({
      executionGroupId: 'run-1',
      robotId: 'robot-a',
      failurePolicy: 'IsolateTarget'
    })
    executionGroups.register({
      executionGroupId: 'run-1',
      robotId: 'robot-b',
      failurePolicy: 'IsolateTarget'
    })

    const resolution = resolveSafetyStop(
      {
        type: 'ground-collision',
        rootRobotIds: ['robot-a']
      },
      {},
      safetyGroups,
      executionGroups
    )

    expect(resolution.stopRobotIds).toEqual(['robot-a', 'robot-c'])
    expect(resolution.stopRobotIds).not.toContain('robot-b')
    expect(resolution.affectedExecutionGroupIds).toEqual([])
  })

  it('does not expand an AbortExecutionGroup when the event explicitly isolates robots', () => {
    executionGroups.register({
      executionGroupId: 'run-strict',
      robotId: 'robot-a',
      failurePolicy: 'AbortExecutionGroup'
    })
    executionGroups.register({
      executionGroupId: 'run-strict',
      robotId: 'robot-b',
      failurePolicy: 'AbortExecutionGroup'
    })

    const resolution = resolveSafetyStop(
      {
        type: 'ground-collision',
        rootRobotIds: ['robot-a'],
        stopScope: 'Robot'
      },
      {},
      safetyGroups,
      executionGroups
    )

    expect(resolution.stopRobotIds).toEqual(['robot-a'])
    expect(resolution.affectedExecutionGroupIds).toEqual([])
  })

  it('computes closure for AbortExecutionGroup and newly reached safety groups', () => {
    safetyGroups.setGroupMembers('cell-a', ['robot-a', 'robot-c'])
    safetyGroups.setGroupMembers('cell-b', ['robot-b', 'robot-d'])
    executionGroups.register({
      executionGroupId: 'run-strict',
      robotId: 'robot-a',
      failurePolicy: 'AbortExecutionGroup'
    })
    executionGroups.register({
      executionGroupId: 'run-strict',
      robotId: 'robot-b',
      failurePolicy: 'AbortExecutionGroup'
    })

    const resolution = resolveSafetyStop(
      {
        type: 'self-collision',
        rootRobotIds: ['robot-a']
      },
      {},
      safetyGroups,
      executionGroups
    )

    expect(resolution.stopRobotIds).toEqual(['robot-a', 'robot-b', 'robot-c', 'robot-d'])
    expect(resolution.executionGroupRobotIds).toEqual(['robot-b'])
    expect(resolution.safetyGroupRobotIds).toEqual(['robot-c', 'robot-d'])
    expect(resolution.affectedExecutionGroupIds).toEqual(['run-strict'])
  })

  it('contains effect failures and continues stopping the remaining robots', () => {
    const cancelRobot = vi.fn((robotId: string) => {
      if (robotId === 'robot-a') throw new Error('cancel transport failed')
      return true
    })
    const latchRobotFault = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const resolution = executeSafetyStop(
        {
          type: 'global-estop',
          rootRobotIds: [],
          stopScope: 'All'
        },
        { cancelRobot, latchRobotFault },
        { allRobotIds: ['robot-a', 'robot-b'] },
        safetyGroups,
        executionGroups
      )

      expect(resolution.stopRobotIds).toEqual(['robot-a', 'robot-b'])
      expect(cancelRobot).toHaveBeenCalledTimes(2)
      expect(latchRobotFault).toHaveBeenCalledTimes(2)
      expect(consoleError).toHaveBeenCalledOnce()
    } finally {
      consoleError.mockRestore()
    }
  })
})
