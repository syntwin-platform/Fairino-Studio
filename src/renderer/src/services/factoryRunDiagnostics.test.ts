import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachFactoryRunDiagnosticId,
  beginFactoryRunDiagnosticSession,
  clearFactoryRunDiagnostics,
  endFactoryRunDiagnosticSession,
  getFactoryRunDiagnosticSnapshot,
  recordFactoryRunDiagnostic,
  subscribeFactoryRunDiagnostics
} from './factoryRunDiagnostics'

describe('factoryRunDiagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T04:00:00.000Z'))
  })

  afterEach(() => {
    clearFactoryRunDiagnostics()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('builds a bounded summary without exposing mutable event storage', () => {
    beginFactoryRunDiagnosticSession('workflow.lua')
    attachFactoryRunDiagnosticId('run-1')

    recordFactoryRunDiagnostic('lua.parse.completed', {
      durationMs: 125,
      details: { stepCount: 13 }
    })
    recordFactoryRunDiagnostic('robot.prepare.completed', {
      robotId: 'robot-1',
      durationMs: 450
    })
    recordFactoryRunDiagnostic('robot.prepare.completed', {
      robotId: 'robot-2',
      durationMs: 700
    })

    endFactoryRunDiagnosticSession()
    const result = getFactoryRunDiagnosticSnapshot()

    expect(result.factoryRunId).toBe('run-1')
    expect(result.active).toBe(false)
    expect(result.summary.luaParseMs).toBe(125)
    expect(result.summary.maxRobotPreparationMs).toBe(700)
    expect(result.events.length).toBe(4)
  })

  it('batches subscriber notifications away from the motion call stack', async () => {
    beginFactoryRunDiagnosticSession('workflow.lua')
    const listener = vi.fn()
    const unsubscribe = subscribeFactoryRunDiagnostics(listener)

    recordFactoryRunDiagnostic('robot.motion.first-frame', {
      robotId: 'robot-1'
    })
    recordFactoryRunDiagnostic('robot.step.started', {
      robotId: 'robot-1',
      stepIndex: 0
    })

    expect(listener).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('keeps only the newest 500 diagnostic events', () => {
    beginFactoryRunDiagnosticSession('workflow.lua')

    for (let index = 0; index < 550; index++) {
      recordFactoryRunDiagnostic('robot.step.started', {
        robotId: 'robot-1',
        stepIndex: index
      })
    }

    endFactoryRunDiagnosticSession()
    const result = getFactoryRunDiagnosticSnapshot()

    expect(result.events).toHaveLength(500)
    expect(result.events[0].stepIndex).toBe(50)
    expect(result.events[499].stepIndex).toBe(549)
  })

  it('ignores events after the session ends', () => {
    beginFactoryRunDiagnosticSession('workflow.lua')
    endFactoryRunDiagnosticSession()
    const eventCount = getFactoryRunDiagnosticSnapshot().events.length

    recordFactoryRunDiagnostic('robot.run.failed', {
      robotId: 'robot-1'
    })

    expect(getFactoryRunDiagnosticSnapshot().events).toHaveLength(eventCount)
  })

  it('clears the active factory session and its account-specific events', () => {
    beginFactoryRunDiagnosticSession('account-workflow.lua')
    attachFactoryRunDiagnosticId('account-run-1')
    recordFactoryRunDiagnostic('robot.step.started', {
      robotId: 'account-robot-1',
      stepIndex: 3
    })

    clearFactoryRunDiagnostics()

    const result = getFactoryRunDiagnosticSnapshot()
    expect(result.sessionId).toBeNull()
    expect(result.factoryRunId).toBeNull()
    expect(result.active).toBe(false)
    expect(result.events).toEqual([])
    expect(result.summary.eventCount).toBe(0)
    expect(result.summary.currentStage).toBeNull()
  })
})
