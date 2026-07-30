import { describe, expect, it } from 'vitest'
import type { BackendSimulatorConfig } from '../types/backendDevice'
import { sanitizeBackendSimulatorConfigForLogout } from './accountSession'

describe('accountSession', () => {
  it('removes account credentials while preserving the selected backend environment', () => {
    const config: BackendSimulatorConfig = {
      enabled: true,
      backendUrl: 'https://staging.example.run.app',
      robotId: 'account-robot-1',
      deviceSecret: 'account-device-secret',
      heartbeatIntervalMs: 3000,
      telemetryIntervalMs: 250,
      commandPollIntervalMs: 1000
    }

    expect(sanitizeBackendSimulatorConfigForLogout(config)).toEqual({
      enabled: false,
      backendUrl: 'https://staging.example.run.app',
      robotId: '',
      deviceSecret: '',
      heartbeatIntervalMs: 3000,
      telemetryIntervalMs: 250,
      commandPollIntervalMs: 1000
    })
  })
})
