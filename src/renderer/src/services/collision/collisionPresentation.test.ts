import { describe, expect, it } from 'vitest'

import type { RobotFaultState, RobotSafetyContactState } from '../../types/robotFault.types'
import {
  buildCollisionAlertPresentation,
  buildRobotCollisionPresentation,
  isTechnicalCollisionError
} from './collisionPresentation'

function collisionFault(robotId: string): RobotFaultState {
  return {
    robotId,
    active: true,
    latched: true,
    kind: 'collision',
    code: 'COLLISION_ROBOT',
    message: `Robot ${robotId} motion blocked.`,
    detectedAtUtc: '2026-07-15T00:00:00.000Z',
    updatedAtUtc: '2026-07-15T00:00:00.000Z'
  }
}

describe('collisionPresentation', () => {
  const robots = [
    { id: 'robot-a', name: 'Fairino FR5 - Line 5' },
    { id: 'robot-b', name: 'Fairino FR5 - Line 6' }
  ]

  it('clears alert after live contact clears even if collision faults remain latched', () => {
    const alert = buildCollisionAlertPresentation(
      robots,
      {},
      {
        'robot-a': collisionFault('robot-a'),
        'robot-b': collisionFault('robot-b')
      },
      'vi'
    )

    expect(alert).toBeNull()
  })

  it('shows an early warning while robots are near but not intersecting', () => {
    const contacts: Record<string, RobotSafetyContactState> = {
      'robot-a': {
        robotId: 'robot-a',
        level: 'proximity',
        kind: 'robot',
        counterpartRobotIds: ['robot-b'],
        objectIds: [],
        message: null,
        detectedAtUtc: '2026-07-15T00:00:00.000Z',
        updatedAtUtc: '2026-07-15T00:00:00.000Z'
      }
    }

    const alert = buildCollisionAlertPresentation(robots, contacts, {}, 'vi')

    expect(alert?.level).toBe('proximity')
    expect(alert?.title).toBe('Các robot đang ở quá gần nhau')
    expect(alert?.robotIds).toEqual(['robot-a', 'robot-b'])
  })

  it('uses the counterpart robot name instead of its technical ID', () => {
    const contacts: Record<string, RobotSafetyContactState> = {
      'robot-a': {
        robotId: 'robot-a',
        level: 'collision',
        kind: 'robot',
        counterpartRobotIds: ['robot-b'],
        objectIds: [],
        message: 'Raw engine message containing robot-b.',
        detectedAtUtc: '2026-07-15T00:00:00.000Z',
        updatedAtUtc: '2026-07-15T00:00:00.000Z'
      }
    }

    const presentation = buildRobotCollisionPresentation('robot-a', robots, contacts, {}, 'vi')

    expect(presentation?.title).toContain('Fairino FR5 - Line 6')
    expect(presentation?.title).not.toContain('robot-b')
  })

  it('recognizes raw collision execution messages so the UI can hide them', () => {
    expect(
      isTechnicalCollisionError(
        'Robot robot-a motion blocked: Robot link upperarm_link intersects robot robot-b.'
      )
    ).toBe(true)
  })
})
