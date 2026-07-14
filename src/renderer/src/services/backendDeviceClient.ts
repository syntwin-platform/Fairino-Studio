import {
  BackendSimulatorConfig,
  DeviceCommandResultPayload,
  DeviceTelemetryPayload,
  PendingDeviceCommand,
  DeviceSessionResponse
} from '../types/backendDevice'

export class BackendDeviceRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'BackendDeviceRequestError'
  }
}

export class BackendDeviceContractError extends Error {
  constructor(message: string) {
    super(`Factory Run arm response contract mismatch: ${message}`)
    this.name = 'BackendDeviceContractError'
  }
}

export interface DeviceFactoryRunArmRequest {
  factoryRunId: string
  targetId: string
  commandId: string
  robotId: string
  receivedAtUtc: string
  armedAtUtc: string
  estimatedStepDurationsMs: number[]
}

export interface DeviceFactoryRunArmResponse {
  factoryRunId: string
  targetId: string
  commandId: string
  robotId: string
  isReady: boolean
  status: string
  scheduledStartAtUtc?: string | null
  expectedParticipantCount: number
  stepDurationsMs?: number[] | null
}

export interface DeviceFactoryRunStartedRequest {
  factoryRunId: string
  targetId: string
  commandId: string
  robotId: string
  actualStartedAtUtc: string
}

export interface DeviceFactoryRunStartedResponse {
  factoryRunId: string
  targetId: string
  commandId: string
  robotId: string
  actualStartedAtUtc: string
  startLateByMs: number
  actualStartSkewMs?: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredString(value: Record<string, unknown>, propertyName: string): string {
  const propertyValue = value[propertyName]

  if (typeof propertyValue !== 'string' || !propertyValue.trim()) {
    throw new BackendDeviceContractError(`${propertyName} must be a non-empty string.`)
  }

  return propertyValue
}

function readOptionalUtcTimestamp(
  value: Record<string, unknown>,
  propertyName: string
): string | null | undefined {
  const propertyValue = value[propertyName]

  if (propertyValue === undefined || propertyValue === null) {
    return propertyValue
  }

  if (typeof propertyValue !== 'string' || !Number.isFinite(Date.parse(propertyValue))) {
    throw new BackendDeviceContractError(`${propertyName} must be a valid UTC timestamp.`)
  }

  return propertyValue
}

export function parseDeviceFactoryRunArmResponse(value: unknown): DeviceFactoryRunArmResponse {
  if (!isRecord(value)) {
    throw new BackendDeviceContractError('response body must be an object.')
  }

  const isReady = value.isReady
  if (typeof isReady !== 'boolean') {
    throw new BackendDeviceContractError('isReady must be a boolean.')
  }

  const scheduledStartAtUtc = readOptionalUtcTimestamp(value, 'scheduledStartAtUtc')
  if (isReady && !scheduledStartAtUtc) {
    throw new BackendDeviceContractError('scheduledStartAtUtc is required when isReady is true.')
  }

  const expectedParticipantCount = value.expectedParticipantCount
  if (!Number.isInteger(expectedParticipantCount) || (expectedParticipantCount as number) <= 0) {
    throw new BackendDeviceContractError('expectedParticipantCount must be a positive integer.')
  }

  const rawStepDurationsMs = value.stepDurationsMs
  let stepDurationsMs: number[] | null | undefined

  if (rawStepDurationsMs === undefined || rawStepDurationsMs === null) {
    stepDurationsMs = rawStepDurationsMs
  } else if (
    Array.isArray(rawStepDurationsMs) &&
    rawStepDurationsMs.every((duration) => Number.isInteger(duration) && (duration as number) >= 0)
  ) {
    stepDurationsMs = [...rawStepDurationsMs] as number[]
  } else {
    throw new BackendDeviceContractError('stepDurationsMs must contain only non-negative integers.')
  }

  return {
    factoryRunId: readRequiredString(value, 'factoryRunId'),
    targetId: readRequiredString(value, 'targetId'),
    commandId: readRequiredString(value, 'commandId'),
    robotId: readRequiredString(value, 'robotId'),
    isReady,
    status: readRequiredString(value, 'status'),
    scheduledStartAtUtc,
    expectedParticipantCount: expectedParticipantCount as number,
    stepDurationsMs
  }
}

function apiUrl(config: BackendSimulatorConfig, path: string): string {
  return `${config.backendUrl.replace(/\/+$/, '')}${path}`
}

function deviceSessionHeaders(config: BackendSimulatorConfig): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Robot-Id': config.robotId,
    'X-Device-Secret': config.deviceSecret
  }
}

function deviceBearerHeaders(accessToken: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  return body.trim()
    ? `HTTP ${response.status}: ${body}`
    : `HTTP ${response.status}: ${response.statusText}`
}

export async function createDeviceSession(
  config: BackendSimulatorConfig
): Promise<DeviceSessionResponse> {
  const response = await fetch(apiUrl(config, '/api/device/session'), {
    method: 'POST',
    headers: deviceSessionHeaders(config)
  })

  if (!response.ok) {
    throw new BackendDeviceRequestError(response.status, await readErrorMessage(response))
  }

  return (await response.json()) as DeviceSessionResponse
}

export async function postHeartbeat(
  config: BackendSimulatorConfig,
  accessToken: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(apiUrl(config, '/api/device/heartbeat'), {
    method: 'POST',
    headers: deviceBearerHeaders(accessToken),
    signal
  })

  if (!response.ok) {
    throw new BackendDeviceRequestError(response.status, await readErrorMessage(response))
  }
}

export async function postTelemetry(
  config: BackendSimulatorConfig,
  telemetry: DeviceTelemetryPayload,
  accessToken: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(apiUrl(config, '/api/device/telemetry'), {
    method: 'POST',
    headers: deviceBearerHeaders(accessToken),
    body: JSON.stringify(telemetry),
    signal
  })

  if (!response.ok) {
    throw new BackendDeviceRequestError(response.status, await readErrorMessage(response))
  }
}

export async function getPendingCommand(
  config: BackendSimulatorConfig,
  accessToken: string,
  isBusy: boolean,
  signal?: AbortSignal
): Promise<PendingDeviceCommand | null> {
  const query = new URLSearchParams({
    isBusy: String(isBusy),
    waitSeconds: '5'
  })

  const response = await fetch(apiUrl(config, `/api/device/commands/pending?${query.toString()}`), {
    method: 'GET',
    headers: deviceBearerHeaders(accessToken),
    signal
  })

  if (response.status === 204) {
    return null
  }

  if (!response.ok) {
    throw new BackendDeviceRequestError(response.status, await readErrorMessage(response))
  }

  return (await response.json()) as PendingDeviceCommand
}

export async function postCommandResult(
  config: BackendSimulatorConfig,
  result: DeviceCommandResultPayload,
  accessToken: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(apiUrl(config, '/api/device/commands/result'), {
    method: 'POST',
    headers: deviceBearerHeaders(accessToken),
    body: JSON.stringify(result),
    signal
  })

  if (!response.ok) {
    throw new BackendDeviceRequestError(response.status, await readErrorMessage(response))
  }
}

export async function postFactoryRunArmed(
  config: BackendSimulatorConfig,
  requestBody: DeviceFactoryRunArmRequest,
  accessToken: string,
  signal?: AbortSignal
): Promise<DeviceFactoryRunArmResponse> {
  const response = await fetch(apiUrl(config, '/api/device/factory-runs/armed'), {
    method: 'POST',
    headers: deviceBearerHeaders(accessToken),
    body: JSON.stringify(requestBody),
    signal
  })

  if (!response.ok) {
    throw new BackendDeviceRequestError(response.status, await readErrorMessage(response))
  }

  return parseDeviceFactoryRunArmResponse(await response.json())
}

export async function postFactoryRunStarted(
  config: BackendSimulatorConfig,
  requestBody: DeviceFactoryRunStartedRequest,
  accessToken: string,
  signal?: AbortSignal
): Promise<DeviceFactoryRunStartedResponse> {
  const response = await fetch(apiUrl(config, '/api/device/factory-runs/started'), {
    method: 'POST',
    headers: deviceBearerHeaders(accessToken),
    body: JSON.stringify(requestBody),
    signal
  })

  if (!response.ok) {
    throw new BackendDeviceRequestError(response.status, await readErrorMessage(response))
  }

  return (await response.json()) as DeviceFactoryRunStartedResponse
}
