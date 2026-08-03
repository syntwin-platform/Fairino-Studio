export const DEVICE_SECRETS_STORAGE_PREFIX = 'syntwin.deviceSecrets.'

export function getSavedDeviceSecretsForAccount(accountIdentifier: string): Record<string, string> {
  if (typeof window === 'undefined' || !accountIdentifier?.trim()) return {}

  try {
    const raw = window.localStorage.getItem(
      `${DEVICE_SECRETS_STORAGE_PREFIX}${accountIdentifier.trim()}`
    )
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

export function saveDeviceSecretsForAccount(
  accountIdentifier: string,
  secretsByRobotId: Record<string, string>
): void {
  if (typeof window === 'undefined' || !accountIdentifier?.trim()) return

  try {
    const existing = getSavedDeviceSecretsForAccount(accountIdentifier)
    const updated = { ...existing }

    let changed = false
    for (const [robotId, secret] of Object.entries(secretsByRobotId)) {
      if (secret && secret.trim() && updated[robotId] !== secret.trim()) {
        updated[robotId] = secret.trim()
        changed = true
      }
    }

    if (changed) {
      window.localStorage.setItem(
        `${DEVICE_SECRETS_STORAGE_PREFIX}${accountIdentifier.trim()}`,
        JSON.stringify(updated)
      )
    }
  } catch (err) {
    console.error('Failed to save device secrets for account:', err)
  }
}
