import type { BackendSimulatorConfig } from '../types/backendDevice'
import { BackendDeviceRequestError, createDeviceSession } from './backendDeviceClient'

const refreshSkewMs = 60_000

interface CachedDeviceSession {
  accessToken: string
  runtimeSessionId?: string | null
  expiresAt: number
}

const cachedSessionsByKey = new Map<string, CachedDeviceSession>()
const activeSessionPromisesByKey = new Map<string, Promise<string>>()

function getSessionKey(config: BackendSimulatorConfig): string {
  return [
    config.backendUrl.trim().replace(/\/+$/, ''),
    config.robotId.trim(),
    config.deviceSecret.trim()
  ].join('|')
}

function getRuntimeSessionStorageKey(config: BackendSimulatorConfig): string {
  return `syntwin.backendDevice.runtimeSessionId.${config.robotId.trim()}`
}

export function getCachedDeviceRuntimeSessionId(config: BackendSimulatorConfig): string | null {
  const key = getSessionKey(config)
  const cachedSession = cachedSessionsByKey.get(key)

  if (cachedSession?.runtimeSessionId) {
    return cachedSession.runtimeSessionId
  }

  return window.sessionStorage.getItem(getRuntimeSessionStorageKey(config))
}

export function invalidateDeviceSession(config?: BackendSimulatorConfig): void {
  if (!config) {
    cachedSessionsByKey.clear()
    activeSessionPromisesByKey.clear()
    return
  }

  const key = getSessionKey(config)
  cachedSessionsByKey.delete(key)
  activeSessionPromisesByKey.delete(key)
}

export async function getDeviceAccessToken(config: BackendSimulatorConfig): Promise<string> {
  const key = getSessionKey(config)
  const now = Date.now()
  const cachedSession = cachedSessionsByKey.get(key)

  if (cachedSession && cachedSession.expiresAt - refreshSkewMs > now) {
    return cachedSession.accessToken
  }

  const activePromise = activeSessionPromisesByKey.get(key)

  if (activePromise) {
    return activePromise
  }

  const sessionPromise = (async () => {
    try {
      const session = await createDeviceSession(config)

      cachedSessionsByKey.set(key, {
        accessToken: session.accessToken,
        runtimeSessionId: session.runtimeSessionId,
        expiresAt: Date.now() + session.expiresInSeconds * 1000
      })

      if (session.runtimeSessionId) {
        window.sessionStorage.setItem(getRuntimeSessionStorageKey(config), session.runtimeSessionId)
      }

      return session.accessToken
    } finally {
      activeSessionPromisesByKey.delete(key)
    }
  })()

  activeSessionPromisesByKey.set(key, sessionPromise)
  return sessionPromise
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

    invalidateDeviceSession(config)
    const refreshedAccessToken = await getDeviceAccessToken(config)
    return await fn(refreshedAccessToken)
  }
}
