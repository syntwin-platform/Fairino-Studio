import type { TcpPose } from '../types/backendDevice'

export interface RobotTelemetryHistoryPoint {
  timestamp: string
  jointAngles: number[]
  tcpPose?: TcpPose | null
  temperature?: number | null
  collisionWarning?: boolean | null
  status?: string | null
  source?: string | null
}

export interface RobotTelemetryHistoryQuery {
  from?: string
  to?: string
  intervalSeconds?: number
  limit?: number
  runtimeSessionId?: string | null
  fields?: string[]
}

export class BackendTelemetryHistoryError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'BackendTelemetryHistoryError'
  }
}

function apiUrl(backendUrl: string, path: string): string {
  return `${backendUrl.replace(/\/+$/, '')}${path}`
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

export async function getRobotTelemetryHistory(
  backendUrl: string,
  robotId: string,
  token: string,
  query: RobotTelemetryHistoryQuery = {},
  signal?: AbortSignal
): Promise<RobotTelemetryHistoryPoint[]> {
  const params = new URLSearchParams()

  if (query.from) params.set('from', query.from)
  if (query.to) params.set('to', query.to)
  if (query.intervalSeconds) params.set('intervalSeconds', String(query.intervalSeconds))
  if (query.limit) params.set('limit', String(query.limit))
  if (query.runtimeSessionId) params.set('runtimeSessionId', query.runtimeSessionId)

  query.fields?.forEach((field) => {
    params.append('fields', field)
  })

  const suffix = params.toString() ? `?${params.toString()}` : ''

  const response = await fetch(
    apiUrl(backendUrl, `/api/robots/${robotId}/telemetry/history${suffix}`),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal
    }
  )

  if (!response.ok) {
    throw new BackendTelemetryHistoryError(response.status, await readErrorMessage(response))
  }

  return (await response.json()) as RobotTelemetryHistoryPoint[]
}
