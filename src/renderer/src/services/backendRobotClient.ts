export interface BackendRobotModel {
  id: string
  vendor: string
  modelCode: string
  displayName: string
  dof: number
  description?: string | null
  urdfPath?: string | null
  meshRootPath?: string | null
  defaultTcpFrame?: string | null
  jointNamesJson?: string | null
  jointLimitsJson?: string | null
  isActive: boolean
}

export interface BackendRobotSceneBinding {
  id: string
  robotId: string
  sceneType: string
  baseX: number
  baseY: number
  baseZ: number
  baseYaw: number
  urdfPath?: string | null
  primPath?: string | null
  rosNamespace?: string | null
  graphPath?: string | null
  createdAt: string
  updatedAt?: string | null
}

export interface BackendRobot {
  id: string
  userId: string
  companyId: string
  robotModelId?: string | null
  currentUserRole: string
  robotName: string
  model: string
  connectionType: string
  status: string
  lastSeenAt?: string | null
  ipAddress?: string | null
  port?: number | null
  createdAt: string
  updatedAt?: string | null
  sceneBinding?: BackendRobotSceneBinding | null
}

export interface CreateBackendRobotSceneBindingRequest {
  sceneType: string
  baseX: number
  baseY: number
  baseZ: number
  baseYaw: number
  urdfPath?: string | null
  primPath?: string | null
  rosNamespace?: string | null
  graphPath?: string | null
}

export interface CreateBackendRobotRequest {
  companyId: string
  robotModelId?: string | null
  robotName: string
  model: string
  connectionType: string
  ipAddress?: string | null
  port?: number | null
  sceneBinding?: CreateBackendRobotSceneBindingRequest | null
}

export interface CreateBackendRobotResponse {
  robot: BackendRobot
  deviceSecret: string
}

export class BackendRobotClientError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'BackendRobotClientError'
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

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')

  if (!text.trim()) {
    return `HTTP ${response.status}: ${response.statusText}`
  }

  try {
    const parsed = JSON.parse(text) as { message?: string }
    return parsed.message || `HTTP ${response.status}: ${text}`
  } catch {
    return `HTTP ${response.status}: ${text}`
  }
}

async function api<T>(
  backendUrl: string,
  path: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  const externalSignal = init?.signal
  const controller = new AbortController()
  let timedOut = false
  const handleExternalAbort = (): void => controller.abort(externalSignal?.reason)
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 8000)

  externalSignal?.addEventListener('abort', handleExternalAbort, { once: true })

  let response: Response

  try {
    response = await fetch(apiUrl(backendUrl, path), {
      ...init,
      signal: controller.signal,
      headers: {
        ...authHeaders(token),
        ...(init?.headers ?? {})
      }
    })
  } catch (error) {
    if (externalSignal?.aborted) throw error

    if (timedOut) {
      throw new BackendRobotClientError(0, 'Backend không phản hồi sau 8 giây.')
    }

    throw new BackendRobotClientError(
      0,
      `Không kết nối được Backend tại ${backendUrl.trim()}. Hãy kiểm tra API đang chạy.`
    )
  } finally {
    globalThis.clearTimeout(timeoutId)
    externalSignal?.removeEventListener('abort', handleExternalAbort)
  }

  if (!response.ok) {
    throw new BackendRobotClientError(response.status, await readErrorMessage(response))
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

export async function listRobotModels(
  backendUrl: string,
  token: string,
  signal?: AbortSignal
): Promise<BackendRobotModel[]> {
  return api<BackendRobotModel[]>(backendUrl, '/api/robot-models', token, {
    method: 'GET',
    signal
  })
}

export async function listRobots(
  backendUrl: string,
  token: string,
  companyId?: string,
  signal?: AbortSignal
): Promise<BackendRobot[]> {
  const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''

  return api<BackendRobot[]>(backendUrl, `/api/robots${query}`, token, {
    method: 'GET',
    signal
  })
}

export async function createRobot(
  backendUrl: string,
  token: string,
  request: CreateBackendRobotRequest,
  signal?: AbortSignal
): Promise<CreateBackendRobotResponse> {
  return api<CreateBackendRobotResponse>(backendUrl, '/api/robots', token, {
    method: 'POST',
    body: JSON.stringify(request),
    signal
  })
}

export type UpdateBackendRobotSceneBindingRequest = CreateBackendRobotSceneBindingRequest

export async function updateRobotSceneBinding(
  backendUrl: string,
  token: string,
  robotId: string,
  request: UpdateBackendRobotSceneBindingRequest,
  signal?: AbortSignal
): Promise<BackendRobot> {
  return api<BackendRobot>(backendUrl, `/api/robots/${robotId}/scene-binding`, token, {
    method: 'PUT',
    body: JSON.stringify(request),
    signal
  })
}

export async function deleteRobot(
  backendUrl: string,
  token: string,
  robotId: string,
  signal?: AbortSignal
): Promise<void> {
  await api<void>(backendUrl, `/api/robots/${robotId}`, token, {
    method: 'DELETE',
    signal
  })
}
