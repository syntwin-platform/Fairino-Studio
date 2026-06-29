import type { BackendSimulatorConfig } from '../types/backendDevice'

const CONFIG_KEY = 'syntwin.backendSimulator.config'
const TOKEN_KEY = 'syntwin.backendProgram.accessToken'

export interface BackendLuaDiagnostic {
  line: number
  severity: 'error' | 'warning'
  message: string
  source: string
}

export interface BackendLuaPreviewStep {
  orderIndex: number
  stepType: string
  label: string
  payload: Record<string, unknown>
  raw?: string
  pointRef?: string
}

export interface BackendLuaPreviewResponse {
  metadata: {
    projectName: string
    robotModel?: string | null
    date?: string | null
    note?: string | null
    author?: string | null
    version?: string | null
  }
  variables: Record<string, unknown>
  points: Record<string, unknown>
  parsedSteps: BackendLuaPreviewStep[]
  diagnostics: BackendLuaDiagnostic[]
  createProgramRequest?: {
    name: string
    status?: string
    source?: string
    steps: Array<{
      orderIndex: number
      stepType: string
      label: string
      payload: Record<string, unknown>
    }>
  } | null
}

export function getBackendLuaConfig(): { config: BackendSimulatorConfig; token: string } {
  const rawConfig = localStorage.getItem(CONFIG_KEY)
  const token = sessionStorage.getItem(TOKEN_KEY) || ''

  if (!rawConfig) {
    throw new Error('Backend Simulator config is missing.')
  }

  if (!token) {
    throw new Error('Please login to Backend Program first.')
  }

  const config = JSON.parse(rawConfig) as BackendSimulatorConfig

  if (!config.backendUrl?.trim()) {
    throw new Error('Backend URL is empty.')
  }

  if (!config.robotId?.trim()) {
    throw new Error('Robot ID is empty.')
  }

  return { config, token }
}

function createLuaImportErrorMessage(status: number, responseText: string): string {
  let message = responseText.trim()

  try {
    const body = JSON.parse(responseText) as { message?: string; title?: string; detail?: string }
    message = body.message || body.detail || body.title || message
  } catch {
    // Plain text responses are common for unhandled backend exceptions in development.
  }

  if (status >= 500) {
    if (
      message.includes('Unable to resolve service') &&
      message.includes('ILuaProgramImportService')
    ) {
      return 'Backend LUA import service is not registered. Add ILuaProgramImportService to backend DI, restart the API, then import again.'
    }

    return `Backend LUA import failed (HTTP ${status}). Check the API log, fix the backend error, then try again.`
  }

  return message || `HTTP ${status}`
}

export async function previewLuaProgram(
  fileName: string,
  luaContent: string
): Promise<BackendLuaPreviewResponse> {
  const { config, token } = getBackendLuaConfig()
  const baseUrl = config.backendUrl.replace(/\/+$/, '')

  const response = await fetch(
    `${baseUrl}/api/robots/${config.robotId}/programs/import/lua/preview`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        fileName,
        luaContent
      })
    }
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(createLuaImportErrorMessage(response.status, text))
  }

  return (await response.json()) as BackendLuaPreviewResponse
}
