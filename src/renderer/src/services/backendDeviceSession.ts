import type { BackendSimulatorConfig } from '../types/backendDevice'
import { BackendDeviceRequestError, createDeviceSession } from './backendDeviceClient'

const refreshSkewMs = 60_000

let cachedSession: {
  key: string
  accessToken: string
  expiresAt: number
} | null = null

let activeSessionPromise: Promise<string> | null = null
let activeSessionKey: string | null = null

function getSessionKey(config: BackendSimulatorConfig): string {
  return [
    config.backendUrl.trim().replace(/\/+$/, ''),
    config.robotId.trim(),
    config.deviceSecret.trim()
  ].join('|')
}

export function invalidateDeviceSession(): void {
  cachedSession = null
  activeSessionPromise = null
  activeSessionKey = null
}

export async function getDeviceAccessToken(config: BackendSimulatorConfig): Promise<string> {
  const key = getSessionKey(config)
  const now = Date.now()

  if (cachedSession && cachedSession.key === key && cachedSession.expiresAt - refreshSkewMs > now) {
    return cachedSession.accessToken
  }

  if (activeSessionPromise && activeSessionKey === key) {
    return activeSessionPromise
  }

  activeSessionKey = key
  activeSessionPromise = (async () => {
    try {
      const session = await createDeviceSession(config)
      cachedSession = {
        key,
        accessToken: session.accessToken,
        expiresAt: Date.now() + session.expiresInSeconds * 1000
      }
      return session.accessToken
    } finally {
      activeSessionPromise = null
      activeSessionKey = null
    }
  })()

  return activeSessionPromise
}

export async function withDeviceToken<T>(
  config: BackendSimulatorConfig,
  fn: (accessToken: string) => Promise<T>
): Promise<T> {
  const accessToken = await getDeviceAccessToken(config)

  try {
    return await fn(accessToken)
  } catch (error) {
    if (!(error instanceof BackendDeviceRequestError) || error.status !== 401) {
      throw error
    }

    invalidateDeviceSession()
    const refreshedAccessToken = await getDeviceAccessToken(config)
    return await fn(refreshedAccessToken)
  }
}
