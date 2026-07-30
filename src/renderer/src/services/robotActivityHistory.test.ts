import { describe, expect, it } from 'vitest'
import { buildRobotActivityEvents } from './robotActivityHistory'

describe('buildRobotActivityEvents', () => {
  it('merges durable history and current-session activity in newest-first order', () => {
    const events = buildRobotActivityEvents({
      commands: [
        {
          id: 'command-1',
          robotId: 'robot-1',
          commandType: 'EStop',
          status: 'Completed',
          createdAt: '2026-07-29T01:00:00.000Z',
          completedAt: '2026-07-29T01:00:02.000Z',
          result: {
            success: true,
            message: 'Stopped',
            completedAt: '2026-07-29T01:00:02.000Z'
          }
        }
      ],
      telemetry: [
        {
          timestamp: '2026-07-29T01:00:03.000Z',
          jointAngles: [0, 0, 0, 0, 0, 0],
          sequenceNumber: 12,
          latencyMilliseconds: 24,
          collisionWarning: false,
          status: 'Online',
          source: 'InfluxDb'
        }
      ],
      runtime: {
        isRunning: true,
        isConnected: true,
        lastHeartbeatAt: '2026-07-29T01:00:04.000Z',
        lastResultAt: '2026-07-29T01:00:01.000Z'
      }
    })

    expect(events.map((event) => event.kind)).toEqual([
      'heartbeat',
      'telemetry',
      'command',
      'result'
    ])
    expect(events[1]).toMatchObject({
      source: 'cloud',
      sequenceNumber: 12,
      latencyMilliseconds: 24
    })
    expect(events[2]).toMatchObject({
      label: 'EStop',
      status: 'Completed',
      detail: 'Stopped'
    })
  })

  it('honors the requested event limit', () => {
    const events = buildRobotActivityEvents({
      commands: [],
      telemetry: [
        { timestamp: '2026-07-29T01:00:01.000Z', jointAngles: [] },
        { timestamp: '2026-07-29T01:00:02.000Z', jointAngles: [] }
      ],
      limit: 1
    })

    expect(events).toHaveLength(1)
    expect(events[0].timestamp).toBe('2026-07-29T01:00:02.000Z')
  })
})
