import type {
  RobotSafetyPolicyDefinition,
  SafetyDiagnostic,
  SafetyPolicyResponse,
  SafetyValidationErrorResponse
} from '../types/backendDevice'

export class SafetyValidationError extends Error {
  readonly diagnostics: SafetyDiagnostic[]

  constructor(message: string, diagnostics: SafetyDiagnostic[]) {
    super(message)
    this.name = 'SafetyValidationError'
    this.diagnostics = diagnostics
  }
}

function apiUrl(backendUrl: string, path: string): string {
  return `${backendUrl.replace(/\/+$/, '')}${path}`
}

function authHeaders(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  }
}

function parseSafetyErrorBody(body: unknown): Partial<SafetyValidationErrorResponse> {
  if (!body || typeof body !== 'object') {
    return {}
  }

  return body as Partial<SafetyValidationErrorResponse>
}

async function readSafetyError(response: Response): Promise<never> {
  let text = ''

  try {
    text = await response.text()
  } catch {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  if (!text.trim()) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  let body: unknown

  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${response.status}: ${text}`)
  }

  const parsed = parseSafetyErrorBody(body)

  if (
    response.status === 400 &&
    Array.isArray(parsed.diagnostics) &&
    parsed.diagnostics.length > 0
  ) {
    throw new SafetyValidationError(
      parsed.message ?? 'Safety validation failed',
      parsed.diagnostics
    )
  }

  throw new Error(parsed.message ?? `HTTP ${response.status}: ${text}`)
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    await readSafetyError(response)
  }

  return (await response.json()) as T
}

export async function getRobotSafetyPolicy(
  backendUrl: string,
  robotId: string,
  token: string
): Promise<SafetyPolicyResponse> {
  const response = await fetch(apiUrl(backendUrl, `/api/robots/${robotId}/safety-policy`), {
    method: 'GET',
    headers: authHeaders(token)
  })

  return readJson<SafetyPolicyResponse>(response)
}

export async function putRobotSafetyPolicy(
  backendUrl: string,
  robotId: string,
  policy: RobotSafetyPolicyDefinition,
  token: string
): Promise<SafetyPolicyResponse> {
  const response = await fetch(apiUrl(backendUrl, `/api/robots/${robotId}/safety-policy`), {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ policy })
  })

  return readJson<SafetyPolicyResponse>(response)
}

export async function deleteRobotSafetyPolicy(
  backendUrl: string,
  robotId: string,
  token: string
): Promise<void> {
  const response = await fetch(apiUrl(backendUrl, `/api/robots/${robotId}/safety-policy`), {
    method: 'DELETE',
    headers: authHeaders(token)
  })

  if (!response.ok) {
    await readSafetyError(response)
  }
}

export async function getCompanySafetyPolicy(
  backendUrl: string,
  companyId: string,
  token: string
): Promise<SafetyPolicyResponse> {
  const response = await fetch(apiUrl(backendUrl, `/api/companies/${companyId}/safety-policy`), {
    method: 'GET',
    headers: authHeaders(token)
  })

  return readJson<SafetyPolicyResponse>(response)
}

export async function putCompanySafetyPolicy(
  backendUrl: string,
  companyId: string,
  policy: RobotSafetyPolicyDefinition,
  token: string
): Promise<SafetyPolicyResponse> {
  const response = await fetch(apiUrl(backendUrl, `/api/companies/${companyId}/safety-policy`), {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ policy })
  })

  return readJson<SafetyPolicyResponse>(response)
}
