import type { BackendAuthUser } from '../store/backendAuthStore'
import { backendFetch } from './backendFetch'

interface BackendLoginResponse {
  accessToken: string
  user: BackendAuthUser
}

interface BackendErrorResponse {
  message?: string
}

function normalizeBackendUrl(backendUrl: string): string {
  return backendUrl.trim().replace(/\/+$/, '')
}

export async function loginToSynTwin(
  backendUrl: string,
  email: string,
  password: string
): Promise<BackendLoginResponse> {
  const response = await backendFetch(`${normalizeBackendUrl(backendUrl)}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: email.trim(),
      password
    })
  })

  const rawBody = await response.text()
  let body: BackendLoginResponse | BackendErrorResponse | null = null

  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as BackendLoginResponse | BackendErrorResponse
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    const message = (body as BackendErrorResponse | null)?.message
    throw new Error(message || `SynTwin returned HTTP ${response.status}.`)
  }

  const loginResponse = body as BackendLoginResponse | null

  if (!loginResponse?.accessToken?.trim() || !loginResponse.user?.id) {
    throw new Error('SynTwin returned an invalid sign-in response.')
  }

  return loginResponse
}
