import { create } from 'zustand'

export const BACKEND_ACCESS_TOKEN_STORAGE_KEY = 'syntwin.backendProgram.accessToken'
export const BACKEND_USER_STORAGE_KEY = 'syntwin.backendProgram.user'

export interface BackendAuthUser {
  id: string
  email: string
  role: string
  status: string
  subscriptionPlan: string
  canView3D: boolean
  canSendCommand: boolean
  maxRobots: number
  timezone: string
  fullName: string
  avatarUrl?: string | null
}

export type BackendConnectivity = 'unknown' | 'checking' | 'online' | 'offline'

interface BackendAuthStore {
  accessToken: string
  user: BackendAuthUser | null
  connectivity: BackendConnectivity
  connectionError: string
  lastCheckedAt: number | null
  setSession: (accessToken: string, user: BackendAuthUser) => void
  setAccessToken: (accessToken: string) => void
  clearSession: () => void
  clearAccessToken: () => void
  setConnectivity: (connectivity: BackendConnectivity, error?: string) => void
}

interface StoredAuthSession {
  accessToken: string
  user: BackendAuthUser | null
}

function readStoredSession(): StoredAuthSession {
  if (typeof window === 'undefined') {
    return {
      accessToken: '',
      user: null
    }
  }

  const accessToken = window.sessionStorage.getItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)?.trim() || ''
  const rawUser = window.sessionStorage.getItem(BACKEND_USER_STORAGE_KEY)

  if (!accessToken || !rawUser) {
    window.sessionStorage.removeItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)
    window.sessionStorage.removeItem(BACKEND_USER_STORAGE_KEY)

    return {
      accessToken: '',
      user: null
    }
  }

  try {
    const user = JSON.parse(rawUser) as BackendAuthUser

    if (!user.id?.trim() || !user.email?.trim()) {
      throw new Error('Invalid stored user')
    }

    return {
      accessToken,
      user
    }
  } catch {
    window.sessionStorage.removeItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)
    window.sessionStorage.removeItem(BACKEND_USER_STORAGE_KEY)

    return {
      accessToken: '',
      user: null
    }
  }
}

const storedSession = readStoredSession()

export const useBackendAuthStore = create<BackendAuthStore>((set) => ({
  accessToken: storedSession.accessToken,
  user: storedSession.user,
  connectivity: 'unknown',
  connectionError: '',
  lastCheckedAt: null,

  setSession: (accessToken, user): void => {
    const normalizedToken = accessToken.trim()

    if (!normalizedToken) {
      return
    }

    window.sessionStorage.setItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY, normalizedToken)
    window.sessionStorage.setItem(BACKEND_USER_STORAGE_KEY, JSON.stringify(user))

    set({
      accessToken: normalizedToken,
      user,
      connectivity: 'online',
      connectionError: '',
      lastCheckedAt: Date.now()
    })
  },

  setAccessToken: (accessToken): void => {
    const normalizedToken = accessToken.trim()

    if (normalizedToken) {
      window.sessionStorage.setItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY, normalizedToken)
    } else {
      window.sessionStorage.removeItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)
    }

    set((state) => ({
      accessToken: normalizedToken,
      user: normalizedToken ? state.user : null,
      connectivity: 'unknown',
      connectionError: '',
      lastCheckedAt: null
    }))
  },

  clearSession: (): void => {
    window.sessionStorage.removeItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)
    window.sessionStorage.removeItem(BACKEND_USER_STORAGE_KEY)
    set({
      accessToken: '',
      user: null,
      connectivity: 'unknown',
      connectionError: '',
      lastCheckedAt: null
    })
  },

  clearAccessToken: (): void => {
    window.sessionStorage.removeItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)
    window.sessionStorage.removeItem(BACKEND_USER_STORAGE_KEY)
    set({
      accessToken: '',
      user: null,
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
