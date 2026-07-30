import { backendDeviceSimulatorManager } from './backendDeviceSimulator'
import { clearFactoryCommandRuntime } from './backendCommandExecutor'
import { clearAllDeviceSessions } from './backendDeviceSession'
import { cancelAllActiveCommands } from './commandExecutionRuntime'
import { clearFactoryRunDiagnostics } from './factoryRunDiagnostics'
import { clearRobotRuntimeConfigs } from './robotMotionRuntime'
import { executionGroupRegistry } from './safety/executionGroupRegistry'
import { safetyGroupRegistry } from './safety/safetyGroupRegistry'
import { useBackendAuthStore } from '../store/backendAuthStore'
import { useFactoryProgramStore } from '../store/factoryProgramStore'
import { useRobotStore } from '../store/robotStore'
import { useSceneStore } from '../store/sceneStore'
import type { BackendSimulatorConfig } from '../types/backendDevice'

export const BACKEND_SIMULATOR_STORAGE_KEY = 'syntwin.backendSimulator.config'
export const BACKEND_SIMULATOR_BY_ROBOT_STORAGE_KEY = 'syntwin.backendSimulator.configByRobotId'
export const BACKEND_PROGRAM_EMAIL_STORAGE_KEY = 'syntwin.backendProgram.email'
export const ADD_ROBOT_COMPANY_STORAGE_KEY = 'syntwin.addRobot.companyId'

export function sanitizeBackendSimulatorConfigForLogout(
  config: BackendSimulatorConfig
): BackendSimulatorConfig {
  return {
    ...config,
    enabled: false,
    robotId: '',
    deviceSecret: ''
  }
}

function clearAccountStorage(): void {
  if (typeof window === 'undefined') return

  window.localStorage.removeItem(BACKEND_SIMULATOR_BY_ROBOT_STORAGE_KEY)
  window.localStorage.removeItem(BACKEND_PROGRAM_EMAIL_STORAGE_KEY)
  window.localStorage.removeItem(ADD_ROBOT_COMPANY_STORAGE_KEY)

  try {
    const rawConfig = window.localStorage.getItem(BACKEND_SIMULATOR_STORAGE_KEY)

    if (rawConfig) {
      const config = JSON.parse(rawConfig) as BackendSimulatorConfig
      window.localStorage.setItem(
        BACKEND_SIMULATOR_STORAGE_KEY,
        JSON.stringify(sanitizeBackendSimulatorConfigForLogout(config))
      )
    }
  } catch {
    window.localStorage.removeItem(BACKEND_SIMULATOR_STORAGE_KEY)
  }
}

export function clearSynTwinAccountSession(): void {
  backendDeviceSimulatorManager.stopAll()
  cancelAllActiveCommands('SynTwin account signed out')
  clearFactoryCommandRuntime()
  clearFactoryRunDiagnostics()
  clearAllDeviceSessions()
  clearRobotRuntimeConfigs()
  executionGroupRegistry.clear()
  safetyGroupRegistry.clear()

  useFactoryProgramStore.getState().reset()
  useSceneStore.getState().clearAllRobotSafetyState()
  useRobotStore.getState().clearAccountSession()

  clearAccountStorage()
  useBackendAuthStore.getState().clearSession()
}
