export const DEVICE_CREDENTIAL_BACKUP_FORMAT = 'syntwin-device-credentials' as const
export const DEVICE_CREDENTIAL_BACKUP_VERSION = 1 as const

export interface DeviceCredentialBackupEntry {
  index: number
  robotId: string
  deviceSecret: string
}

export interface DeviceCredentialBackup {
  format: typeof DEVICE_CREDENTIAL_BACKUP_FORMAT
  version: typeof DEVICE_CREDENTIAL_BACKUP_VERSION
  exportedAt: string
  robots: DeviceCredentialBackupEntry[]
}

export interface ParsedDeviceCredentialBackup {
  credentials: DeviceCredentialBackupEntry[]
  rejectedCount: number
}

function normalizeCredentialEntries(entries: unknown[]): ParsedDeviceCredentialBackup {
  const credentials: DeviceCredentialBackupEntry[] = []
  const seenRobotIds = new Set<string>()
  let rejectedCount = 0

  for (const item of entries) {
    if (!item || typeof item !== 'object') {
      rejectedCount += 1
      continue
    }

    const candidate = item as Record<string, unknown>
    const robotId = typeof candidate.robotId === 'string' ? candidate.robotId.trim() : ''
    const deviceSecret =
      typeof candidate.deviceSecret === 'string' ? candidate.deviceSecret.trim() : ''

    if (!robotId || !deviceSecret || seenRobotIds.has(robotId)) {
      rejectedCount += 1
      continue
    }

    seenRobotIds.add(robotId)
    credentials.push({
      index: credentials.length + 1,
      robotId,
      deviceSecret
    })
  }

  return { credentials, rejectedCount }
}

export function parseDeviceCredentialBackup(input: unknown): ParsedDeviceCredentialBackup {
  if (Array.isArray(input)) {
    return normalizeCredentialEntries(input)
  }

  if (!input || typeof input !== 'object') {
    throw new Error('Invalid device credential backup format.')
  }

  const backup = input as Record<string, unknown>

  if (
    backup.format !== DEVICE_CREDENTIAL_BACKUP_FORMAT ||
    backup.version !== DEVICE_CREDENTIAL_BACKUP_VERSION ||
    !Array.isArray(backup.robots)
  ) {
    throw new Error('Unsupported device credential backup format or version.')
  }

  return normalizeCredentialEntries(backup.robots)
}

export function createDeviceCredentialBackup(
  entries: Array<{ robotId: string; deviceSecret: string }>,
  exportedAt = new Date()
): DeviceCredentialBackup {
  const { credentials } = normalizeCredentialEntries(entries)

  return {
    format: DEVICE_CREDENTIAL_BACKUP_FORMAT,
    version: DEVICE_CREDENTIAL_BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    robots: credentials
  }
}

export function serializeDeviceCredentialBackup(
  entries: Array<{ robotId: string; deviceSecret: string }>,
  exportedAt = new Date()
): string {
  return `${JSON.stringify(createDeviceCredentialBackup(entries, exportedAt), null, 2)}\n`
}
