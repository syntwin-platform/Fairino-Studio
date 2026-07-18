import { create } from 'zustand'

export const BACKEND_ACCESS_TOKEN_STORAGE_KEY = 'syntwin.backendProgram.accessToken'

export type BackendConnectivity = 'unknown' | 'checking' | 'online' | 'offline'

interface BackendAuthStore {
  accessToken: string
  connectivity: BackendConnectivity
  connectionError: string
  lastCheckedAt: number | null
  setAccessToken: (accessToken: string) => void
  clearAccessToken: () => void
  setConnectivity: (connectivity: BackendConnectivity, error?: string) => void
}

function readStoredAccessToken(): string {
  if (typeof window === 'undefined') return ''

  return window.sessionStorage.getItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY) || ''
}

export const useBackendAuthStore = create<BackendAuthStore>((set) => ({
  accessToken: readStoredAccessToken(),
  connectivity: 'unknown',
  connectionError: '',
  lastCheckedAt: null,

  setAccessToken: (accessToken): void => {
    const normalizedToken = accessToken.trim()

    if (normalizedToken) {
      window.sessionStorage.setItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY, normalizedToken)
    } else {
      window.sessionStorage.removeItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)
    }

    set({
      accessToken: normalizedToken,
      connectivity: 'unknown',
      connectionError: '',
      lastCheckedAt: null
    })
  },

  clearAccessToken: (): void => {
    window.sessionStorage.removeItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)
    set({
      accessToken: '',
      connectivity: 'unknown',
      connectionError: '',
      lastCheckedAt: null
    })
  },

  setConnectivity: (connectivity, error = ''): void => {
    set({
      connectivity,
      connectionError: error,
      lastCheckedAt: connectivity === 'checking' ? null : Date.now()
    })
  }
}))
