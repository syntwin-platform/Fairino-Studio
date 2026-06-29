import type { RobotRuntimeConfig } from '../types/backendDevice'

function apiUrl(backendUrl: string, path: string): string {
  return `${backendUrl.replace(/\/+$/, '')}${path}`
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')

  if (!body.trim()) {
    return `HTTP ${response.status}: ${response.statusText}`
  }

  try {
    const parsed = JSON.parse(body) as { message?: string }
    return parsed.message || `HTTP ${response.status}: ${body}`
  } catch {
    return `HTTP ${response.status}: ${body}`
  }
}

export async function getRobotRuntimeConfig(
  backendUrl: string,
  robotId: string,
  token: string
): Promise<RobotRuntimeConfig> {
  const response = await fetch(apiUrl(backendUrl, `/api/robots/${robotId}/runtime-config`), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`
    }
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  return (await response.json()) as RobotRuntimeConfig
}
