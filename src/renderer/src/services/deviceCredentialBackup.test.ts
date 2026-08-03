import { describe, expect, it } from 'vitest'
import {
  createDeviceCredentialBackup,
  DEVICE_CREDENTIAL_BACKUP_FORMAT,
  parseDeviceCredentialBackup
} from './deviceCredentialBackup'

describe('deviceCredentialBackup', () => {
  it('imports the legacy array format', () => {
    const result = parseDeviceCredentialBackup([
      { index: 8, robotId: ' robot-1 ', deviceSecret: ' secret-1 ' }
    ])

    expect(result).toEqual({
      credentials: [{ index: 1, robotId: 'robot-1', deviceSecret: 'secret-1' }],
      rejectedCount: 0
    })
  })

  it('creates and imports the versioned backup format', () => {
    const exportedAt = new Date('2026-08-03T00:00:00.000Z')
    const backup = createDeviceCredentialBackup(
      [{ robotId: 'robot-1', deviceSecret: 'secret-1' }],
      exportedAt
    )

    expect(backup).toEqual({
      format: DEVICE_CREDENTIAL_BACKUP_FORMAT,
      version: 1,
      exportedAt: exportedAt.toISOString(),
      robots: [{ index: 1, robotId: 'robot-1', deviceSecret: 'secret-1' }]
    })
    expect(parseDeviceCredentialBackup(backup).credentials).toEqual(backup.robots)
  })

  it('rejects malformed and duplicate entries without exposing their values', () => {
    const result = parseDeviceCredentialBackup([
      { robotId: 'robot-1', deviceSecret: 'secret-1' },
      { robotId: 'robot-1', deviceSecret: 'secret-2' },
      { robotId: '', deviceSecret: 'secret-3' },
      null
    ])

    expect(result.credentials).toHaveLength(1)
    expect(result.rejectedCount).toBe(3)
  })

  it('rejects an unsupported version', () => {
    expect(() =>
      parseDeviceCredentialBackup({
        format: DEVICE_CREDENTIAL_BACKUP_FORMAT,
        version: 2,
        robots: []
      })
    ).toThrow('Unsupported')
  })
})
