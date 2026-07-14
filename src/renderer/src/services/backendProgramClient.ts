import { SafetyValidationError } from './backendSafetyClient'
import type { SafetyDiagnostic } from '../types/backendDevice'

export interface BackendProgramContext {
  backendUrl: string
  token: string
}

export interface BackendCommandResult {
  success: boolean
  message?: string | null
  rawPayload?: unknown
  completedAt: string
}

export interface BackendCommandResponse {
  id: string
  robotId: string
  commandType: string
  status: string
  createdAt: string
  completedAt?: string | null
  failureReason?: string | null
  result?: BackendCommandResult | null
}

function url(context: BackendProgramContext, path: string): string {
  return `${context.backendUrl.trim().replace(/\/+$/, '')}${path}`
}

async function request<T>(
  context: BackendProgramContext,
  path: string,
  init: RequestInit
): Promise<T> {
  const response = await fetch(url(context, path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${context.token.trim()}`,
      ...(init.headers ?? {})
    }
  })

  const text = await response.text()

  if (!response.ok) {
    let body: {
      message?: string
      diagnostics?: SafetyDiagnostic[]
    } = {}

    try {
      body = JSON.parse(text) as typeof body
    } catch {
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    if (response.status === 400 && Array.isArray(body.diagnostics) && body.diagnostics.length > 0) {
      throw new SafetyValidationError(body.message ?? 'Safety validation failed', body.diagnostics)
    }

    throw new Error(body.message ?? `HTTP ${response.status}: ${text}`)
  }

  return text ? (JSON.parse(text) as T) : (undefined as T)
}

export async function publishRobotProgram(
  context: BackendProgramContext,
  robotId: string,
  programId: string,
  signal?: AbortSignal
): Promise<void> {
  await request(
    context,
    `/api/robots/${encodeURIComponent(robotId)}/programs/${encodeURIComponent(programId)}/publish`,
    { method: 'POST', signal }
  )
}

export async function enqueueRunProgram(
  context: BackendProgramContext,
  robotId: string,
  programId: string,
  factoryRunId?: string,
  signal?: AbortSignal
): Promise<BackendCommandResponse> {
  return request(context, `/api/robots/${encodeURIComponent(robotId)}/commands`, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      commandType: 'RunProgram',
      payload: {
        programId,
        ...(factoryRunId ? { factoryRunId } : {})
      }
    })
  })
}

export async function listRobotCommands(
  context: BackendProgramContext,
  robotId: string,
  signal?: AbortSignal
): Promise<BackendCommandResponse[]> {
  return request(context, `/api/robots/${encodeURIComponent(robotId)}/commands`, {
    method: 'GET',
    signal
  })
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const timeoutId = window.setTimeout(resolve, milliseconds)

    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeoutId)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

export async function waitForRobotCommand(
  context: BackendProgramContext,
  robotId: string,
  commandId: string,
  signal?: AbortSignal
): Promise<BackendCommandResponse> {
  let latest: BackendCommandResponse | undefined

  for (let attempt = 0; attempt < 300; attempt++) {
    const commands = await listRobotCommands(context, robotId, signal)
    latest = commands.find((command) => command.id === commandId) ?? latest

    if (latest && ['Completed', 'Failed', 'Timeout', 'Cancelled'].includes(latest.status)) {
      return latest
    }

    await wait(1000, signal)
  }

  throw new Error(`Command ${commandId} monitoring timed out.`)
}
