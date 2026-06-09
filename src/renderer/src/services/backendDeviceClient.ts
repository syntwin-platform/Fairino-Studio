import {
  BackendSimulatorConfig,
  DeviceCommandResultPayload,
  DeviceTelemetryPayload,
  PendingDeviceCommand
} from '../types/backendDevice'

function apiUrl(config: BackendSimulatorConfig, path: string): string {
  return `${config.backendUrl.replace(/\/+$/, '')}${path}`
}

function deviceHeaders(config: BackendSimulatorConfig): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Robot-Id': config.robotId,
    'X-Device-Secret': config.deviceSecret
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  return body.trim()
    ? `HTTP ${response.status}: ${body}`
    : `HTTP ${response.status}: ${response.statusText}`
}

export async function postHeartbeat(config: BackendSimulatorConfig): Promise<void> {
  const response = await fetch(apiUrl(config, '/api/device/heartbeat'), {
    method: 'POST',
    headers: deviceHeaders(config)
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }
}

export async function postTelemetry(
  config: BackendSimulatorConfig,
  telemetry: DeviceTelemetryPayload
): Promise<void> {
  const response = await fetch(apiUrl(config, '/api/device/telemetry'), {
    method: 'POST',
    headers: deviceHeaders(config),
    body: JSON.stringify(telemetry)
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }
}

export async function getPendingCommand(
  config: BackendSimulatorConfig
): Promise<PendingDeviceCommand | null> {
  const response = await fetch(apiUrl(config, '/api/device/commands/pending'), {
    method: 'GET',
    headers: deviceHeaders(config)
  })

  if (response.status === 204) {
    return null
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  return (await response.json()) as PendingDeviceCommand
}

export async function postCommandResult(
  config: BackendSimulatorConfig,
  result: DeviceCommandResultPayload
): Promise<void> {
  const response = await fetch(apiUrl(config, '/api/device/commands/result'), {
    method: 'POST',
    headers: deviceHeaders(config),
    body: JSON.stringify(result)
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }
}
