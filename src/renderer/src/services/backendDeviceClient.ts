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
    waitSeconds: '25'
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
