import type { SafetyDiagnostic } from '../types/backendDevice'
import type {
  FactoryCoordinationMode,
  FactoryFailurePolicy,
  FactoryRunTargetTerminationReason
} from '../types/factoryProgram.types'
import { SafetyValidationError } from './backendSafetyClient'

export interface BackendFactoryRunContext {
  backendUrl: string
  token: string
}

export interface CreateFactoryRunRequest {
  clientRequestId?: string
  companyId: string
  coordinationMode: FactoryCoordinationMode
  failurePolicy: FactoryFailurePolicy
  programName?: string
  luaFileName?: string
  luaContent?: string
  robotIds?: string[]
  programs?: CreateFactoryRunProgramRequest[]
  targets?: CreateFactoryRunTargetRequest[]
}

export interface CreateFactoryRunProgramRequest {
  key: string
  programName: string
  luaFileName: string
  luaContent: string
}

export interface CreateFactoryRunTargetRequest {
  robotId: string
  programKey: string
}

export interface FactoryRunProgramResponse {
  id: string
  factoryRunId: string
  programKey: string
  programName: string
  luaFileName: string
  luaContentHash: string
  compiledProgramHash?: string | null
  syncPlanHash?: string | null
}

export interface FactoryRunTargetResponse {
  id: string
  factoryRunId: string
  robotId: string
  factoryRunProgramId?: string | null
  programId?: string | null
  prepareCommandId?: string | null
  commandId?: string | null
  cancelCommandId?: string | null
  runtimeSessionId?: string | null
  status: string
  terminationReason?: FactoryRunTargetTerminationReason | null
  readinessError?: string | null
  prepareStartedAtUtc?: string | null
  preparedAtUtc?: string | null
  readyAtUtc?: string | null
  commandReceivedAtUtc?: string | null
  armedAtUtc?: string | null
  estimatedStepDurationsMs?: number[] | null
  startedAtUtc?: string | null
  actualStartedAtUtc?: string | null
  startLateByMs?: number | null
  completedAtUtc?: string | null
  failureReason?: string | null
}

export interface FactoryRunResponse {
  id: string
  companyId: string
  createdByUserId: string
  clientRequestId?: string | null
  status: string
  coordinationMode: FactoryCoordinationMode
  failurePolicy: FactoryFailurePolicy
  programName: string
  luaFileName: string
  luaContentHash: string
  targetCount: number
  scheduledStartAtUtc?: string | null
  stepDurationsMs?: number[] | null
  preparedAtUtc?: string | null
  startedAtUtc?: string | null
  actualStartSkewMs?: number | null
  completedAtUtc?: string | null
  cancelledAtUtc?: string | null
  failureReason?: string | null
  createdAtUtc: string
  updatedAtUtc?: string | null
  programs?: FactoryRunProgramResponse[]
  targets: FactoryRunTargetResponse[]
}

function normalizeBackendUrl(backendUrl: string): string {
  const normalized = backendUrl.trim().replace(/\/+$/, '')

  if (!normalized) {
    throw new Error('Backend URL is empty.')
  }

  return normalized
}

function normalizeToken(token: string): string {
  const normalized = token.trim()

  if (!normalized) {
    throw new Error('Backend token is missing.')
  }

  return normalized
}

function apiUrl(context: BackendFactoryRunContext, path: string): string {
  return `${normalizeBackendUrl(context.backendUrl)}${path}`
}

async function readError(response: Response): Promise<{
  message: string
  diagnostics?: SafetyDiagnostic[]
}> {
  const text = await response.text().catch(() => '')

  if (!text.trim()) {
    return {
      message: `HTTP ${response.status}: ${response.statusText}`
    }
  }

  try {
    const body = JSON.parse(text) as {
      message?: string
      title?: string
      detail?: string
      diagnostics?: SafetyDiagnostic[]
    }

    return {
      message: body.message || body.detail || body.title || `HTTP ${response.status}: ${text}`,
      diagnostics: body.diagnostics
    }
  } catch {
    return {
      message: `HTTP ${response.status}: ${text}`
    }
  }
}

async function request<T>(
  context: BackendFactoryRunContext,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = normalizeToken(context.token)

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(apiUrl(context, path), {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {})
        }
      })

      if (!response.ok) {
        const error = await readError(response)

        if (response.status === 400 && error.diagnostics && error.diagnostics.length > 0) {
          throw new SafetyValidationError(error.message, error.diagnostics)
        }

        if (attempt < 2 && isTransientStatus(response.status)) {
          await waitBeforeRetry(150 * 2 ** attempt, init.signal)
          continue
        }

        throw new Error(error.message)
      }

      if (response.status === 204) {
        return undefined as T
      }

      return (await response.json()) as T
    } catch (error) {
      if (isAbortError(error) || error instanceof SafetyValidationError) {
        throw error
      }

      if (attempt < 2 && error instanceof TypeError) {
        await waitBeforeRetry(150 * 2 ** attempt, init.signal)
        continue
      }

      throw error
    }
  }

  throw new Error('FactoryRun request exhausted its retry budget.')
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function waitBeforeRetry(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const timeoutId = globalThis.setTimeout(resolve, milliseconds)

    signal?.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timeoutId)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

export async function createFactoryRun(
  context: BackendFactoryRunContext,
  requestBody: CreateFactoryRunRequest,
  signal?: AbortSignal
): Promise<FactoryRunResponse> {
  return request<FactoryRunResponse>(context, '/api/factory-runs', {
    method: 'POST',
    signal,
    body: JSON.stringify(requestBody)
  })
}

export async function prepareFactoryRun(
  context: BackendFactoryRunContext,
  factoryRunId: string,
  signal?: AbortSignal
): Promise<FactoryRunResponse> {
  return request<FactoryRunResponse>(
    context,
    `/api/factory-runs/${encodeURIComponent(factoryRunId)}/prepare`,
    {
      method: 'POST',
      signal
    }
  )
}

export async function startFactoryRun(
  context: BackendFactoryRunContext,
  factoryRunId: string,
  signal?: AbortSignal
): Promise<FactoryRunResponse> {
  return request<FactoryRunResponse>(
    context,
    `/api/factory-runs/${encodeURIComponent(factoryRunId)}/start`,
    {
      method: 'POST',
      signal
    }
  )
}

export async function cancelFactoryRun(
  context: BackendFactoryRunContext,
  factoryRunId: string,
  signal?: AbortSignal
): Promise<FactoryRunResponse> {
  return request<FactoryRunResponse>(
    context,
    `/api/factory-runs/${encodeURIComponent(factoryRunId)}/cancel`,
    {
      method: 'POST',
      signal
    }
  )
}

export async function getFactoryRun(
  context: BackendFactoryRunContext,
  factoryRunId: string,
  signal?: AbortSignal
): Promise<FactoryRunResponse> {
  return request<FactoryRunResponse>(
    context,
    `/api/factory-runs/${encodeURIComponent(factoryRunId)}`,
    {
      method: 'GET',
      signal
    }
  )
}
