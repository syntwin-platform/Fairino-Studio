import { backendFetch } from './backendFetch'

export interface BackendLuaExportResponse {
  robotId: string
  programId: string
  programName: string
  fileName: string
  luaContent: string
  exportedAt: string
}

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

export async function exportLuaProgramFromBackend(
  backendUrl: string,
  robotId: string,
  programId: string,
  token: string
): Promise<BackendLuaExportResponse> {
  const response = await backendFetch(
    apiUrl(backendUrl, `/api/robots/${robotId}/programs/${programId}/export/lua`),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  )

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  return (await response.json()) as BackendLuaExportResponse
}
