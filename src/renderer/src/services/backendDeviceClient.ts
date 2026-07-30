import {
  BackendSimulatorConfig,
  DeviceCommandResultPayload,
  DeviceTelemetryPayload,
  PendingDeviceCommand,
  DeviceSessionResponse
} from '../types/backendDevice'
import { backendFetch } from './backendFetch'

export class BackendDeviceRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errorCode?: string,
    readonly retryable = false,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'BackendDeviceRequestError'
  }
}

export class BackendDeviceContractError extends Error {
  constructor(message: string) {
    super(`Device response contract mismatch: ${message}`)
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

export interface DeviceFactoryRunProgramArtifactStep {
  orderIndex: number
  stepType: string
  label?: string
  payload?: unknown
}

export interface DeviceFactoryRunProgramArtifactResponse {
  factoryRunId: string
  targetId: string
  factoryRunProgramId: string
  contractVersion: number
  compiledProgramHash: string
  programName: string
  steps: DeviceFactoryRunProgramArtifactStep[]
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

export function parseDeviceFactoryRunProgramArtifactResponse(
  value: unknown
): DeviceFactoryRunProgramArtifactResponse {
  if (!isRecord(value)) {
    throw new BackendDeviceContractError('program artifact response body must be an object.')
  }

  if (value.contractVersion !== 1) {
    throw new BackendDeviceContractError('program artifact contractVersion must be 1.')
  }

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new BackendDeviceContractError('program artifact steps must be a non-empty array.')
  }

  const orderIndexes = new Set<number>()
  const steps = value.steps.map((rawStep, index): DeviceFactoryRunProgramArtifactStep => {
    if (!isRecord(rawStep)) {
      throw new BackendDeviceContractError(`program artifact step ${index + 1} must be an object.`)
    }

    if (!Number.isInteger(rawStep.orderIndex) || (rawStep.orderIndex as number) < 1) {
      throw new BackendDeviceContractError(
        `program artifact step ${index + 1} has an invalid orderIndex.`
      )
    }

    const orderIndex = rawStep.orderIndex as number
    if (orderIndexes.has(orderIndex)) {
      throw new BackendDeviceContractError(
        `program artifact contains duplicate orderIndex ${orderIndex}.`
      )
    }
    orderIndexes.add(orderIndex)

    if (typeof rawStep.stepType !== 'string' || !rawStep.stepType.trim()) {
      throw new BackendDeviceContractError(`program artifact step ${orderIndex} requires stepType.`)
    }

    return {
      orderIndex,
      stepType: rawStep.stepType.trim(),
      label: typeof rawStep.label === 'string' ? rawStep.label : undefined,
      payload: rawStep.payload
    }
  })

  return {
    factoryRunId: readRequiredString(value, 'factoryRunId'),
    targetId: readRequiredString(value, 'targetId'),
    factoryRunProgramId: readRequiredString(value, 'factoryRunProgramId'),
    contractVersion: 1,
    compiledProgramHash: readRequiredString(value, 'compiledProgramHash'),
    programName: readRequiredString(value, 'programName'),
    steps: steps.sort((first, second) => first.orderIndex - second.orderIndex)
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

async function readDeviceRequestError(response: Response): Promise<BackendDeviceRequestError> {
  const body = await response.text().catch(() => '')
  let errorCode: string | undefined
  let retryable = false
  let retryAfterMs: number | undefined
  let message = body.trim() || response.statusText

  if (body.trim()) {
    try {
      const parsed = JSON.parse(body) as unknown
      if (isRecord(parsed)) {
        if (typeof parsed.message === 'string' && parsed.message.trim()) {
          message = parsed.message.trim()
        }
        if (typeof parsed.errorCode === 'string' && parsed.errorCode.trim()) {
          errorCode = parsed.errorCode.trim()
        }
        if (typeof parsed.retryable === 'boolean') {
          retryable = parsed.retryable
        }
        if (
          typeof parsed.retryAfterMs === 'number' &&
          Number.isFinite(parsed.retryAfterMs) &&
          parsed.retryAfterMs >= 0
        ) {
          retryAfterMs = Math.round(parsed.retryAfterMs)
        }
      }
    } catch {
      // Keep the raw response body for backward-compatible, non-JSON errors.
    }
  }

  return new BackendDeviceRequestError(
    response.status,
    `HTTP ${response.status}: ${message}`,
    errorCode,
    retryable,
    retryAfterMs
  )
}

export async function createDeviceSession(
  config: BackendSimulatorConfig
): Promise<DeviceSessionResponse> {
  const response = await backendFetch(apiUrl(config, '/api/device/session'), {
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
  const response = await backendFetch(apiUrl(config, '/api/device/heartbeat'), {
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
  const response = await backendFetch(apiUrl(config, '/api/device/telemetry'), {
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

  const response = await backendFetch(
    apiUrl(config, `/api/device/commands/pending?${query.toString()}`),
    {
      method: 'GET',
      headers: deviceBearerHeaders(accessToken),
      signal
    }
  )

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
  const response = await backendFetch(apiUrl(config, '/api/device/commands/result'), {
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
  const response = await backendFetch(apiUrl(config, '/api/device/factory-runs/armed'), {
    method: 'POST',
    headers: deviceBearerHeaders(accessToken),
    body: JSON.stringify(requestBody),
    signal
  })

  if (!response.ok) {
    throw await readDeviceRequestError(response)
  }

  return parseDeviceFactoryRunArmResponse(await response.json())
}

export async function postFactoryRunStarted(
  config: BackendSimulatorConfig,
  requestBody: DeviceFactoryRunStartedRequest,
  accessToken: string,
  signal?: AbortSignal
): Promise<DeviceFactoryRunStartedResponse> {
  const response = await backendFetch(apiUrl(config, '/api/device/factory-runs/started'), {
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

export async function getFactoryRunProgramArtifact(
  config: BackendSimulatorConfig,
  factoryRunId: string,
  targetId: string,
  accessToken: string,
  signal?: AbortSignal
): Promise<DeviceFactoryRunProgramArtifactResponse> {
  const response = await backendFetch(
    apiUrl(
      config,
      `/api/device/factory-runs/${encodeURIComponent(factoryRunId)}` +
        `/targets/${encodeURIComponent(targetId)}/program-artifact`
    ),
    {
      method: 'GET',
      headers: deviceBearerHeaders(accessToken),
      signal
    }
  )

  if (!response.ok) {
    throw await readDeviceRequestError(response)
  }

  return parseDeviceFactoryRunProgramArtifactResponse(await response.json())
}
