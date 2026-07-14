import { useState, useEffect } from 'react'
import Header from './components/layout/Header'
import RobotSidebar from './components/robot/RobotSidebar'
import Viewport3D from './components/viewport/Viewport3D'
import WorkflowPanel from './components/workflow/WorkflowPanel'
import BottomConsole from './components/ui/BottomConsole'
import {
  BackendSimulatorConfig,
  BackendSimulatorConfigByRobotId,
  BackendSimulatorStatus,
  BackendSimulatorStatusByRobotId,
  createDisconnectedBackendSimulatorStatus,
  defaultBackendSimulatorConfig,
  defaultRobotRuntimeConfig
} from './types/backendDevice'
import { backendDeviceSimulatorManager } from './services/backendDeviceSimulator'
import { getRobotRuntimeConfig as fetchRobotRuntimeConfig } from './services/backendRuntimeConfigClient'
import { setRobotRuntimeConfig } from './services/robotMotionRuntime'
import BackendProgramControls from './components/BackendProgramControls'
import { useRobotStore } from './store/robotStore'
const STORAGE_KEY = 'syntwin.backendSimulator.config'
const MULTI_STORAGE_KEY = 'syntwin.backendSimulator.configByRobotId'
const TOKEN_KEY = 'syntwin.backendProgram.accessToken'

function loadConfig(): BackendSimulatorConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultBackendSimulatorConfig

    return {
      ...defaultBackendSimulatorConfig,
      ...JSON.parse(raw)
    }
  } catch {
    return defaultBackendSimulatorConfig
  }
}

function loadConfigByRobotId(): BackendSimulatorConfigByRobotId {
  try {
    const raw = window.localStorage.getItem(MULTI_STORAGE_KEY)
    if (!raw) return {}

    return JSON.parse(raw) as BackendSimulatorConfigByRobotId
  } catch {
    return {}
  }
}

async function loadRuntimeConfigForSimulator(
  config: BackendSimulatorConfig
): Promise<string | null> {
  const token = window.sessionStorage.getItem(TOKEN_KEY)

  if (!token) {
    setRobotRuntimeConfig({
      ...defaultRobotRuntimeConfig,
      robotId: config.robotId
    })

    return null
  }

  try {
    const runtimeConfig = await fetchRobotRuntimeConfig(config.backendUrl, config.robotId, token)

    setRobotRuntimeConfig(runtimeConfig)
    return null
  } catch (error) {
    setRobotRuntimeConfig({
      ...defaultRobotRuntimeConfig,
      robotId: config.robotId
    })

    return error instanceof Error ? error.message : 'Failed to load runtime config.'
  }
}

function App(): React.JSX.Element {
  const setRobotRuntime = useRobotStore((state) => state.setRobotRuntime)
  const clearRobotExecution = useRobotStore((state) => state.clearRobotExecution)
  const clearAllRobotRuntime = useRobotStore((state) => state.clearAllRobotRuntime)
  const workspaceMode = useRobotStore((state) => state.workspaceMode)
  const [config, setConfig] = useState<BackendSimulatorConfig>(() => loadConfig())
  const [configByRobotId, setConfigByRobotId] = useState<BackendSimulatorConfigByRobotId>(() =>
    loadConfigByRobotId()
  )
  const [status, setStatus] = useState<BackendSimulatorStatus>({
    isRunning: false,
    isConnected: false
  })
  const [statusByRobotId, setStatusByRobotId] = useState<BackendSimulatorStatusByRobotId>({})

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  }, [config])

  useEffect(() => {
    window.localStorage.setItem(MULTI_STORAGE_KEY, JSON.stringify(configByRobotId))
  }, [configByRobotId])

  useEffect(() => {
    return () => {
      backendDeviceSimulatorManager.stopAll()
      clearAllRobotRuntime()
    }
  }, [clearAllRobotRuntime])

  const handleConnectRobot = async (nextConfig: BackendSimulatorConfig): Promise<void> => {
    const normalizedConfig: BackendSimulatorConfig = {
      ...nextConfig,
      backendUrl: nextConfig.backendUrl.trim(),
      robotId: nextConfig.robotId.trim(),
      deviceSecret: nextConfig.deviceSecret.trim()
    }
    const robotId = normalizedConfig.robotId

    try {
      const runtimeConfigWarning = await loadRuntimeConfigForSimulator(normalizedConfig)

      if (runtimeConfigWarning) {
        console.warn(`Runtime config fallback: ${runtimeConfigWarning}`)
      }

      if (robotId) {
        clearRobotExecution(robotId)
      }

      backendDeviceSimulatorManager.start(
        {
          ...normalizedConfig,
          enabled: true
        },
        {
          onStatusChange: (partial) => {
            setStatus((current) =>
              config.robotId.trim() === robotId
                ? {
                    ...current,
                    ...partial
                  }
                : current
            )

            if (robotId) {
              setStatusByRobotId((current) => ({
                ...current,
                [robotId]: {
                  ...(current[robotId] ?? createDisconnectedBackendSimulatorStatus()),
                  ...partial
                }
              }))

              setRobotRuntime(robotId, partial)
            }
          }
        }
      )

      setConfig((current) =>
        current.robotId.trim() === robotId
          ? {
              ...normalizedConfig,
              enabled: true
            }
          : current
      )

      if (robotId) {
        setConfigByRobotId((current) => ({
          ...current,
          [robotId]: {
            ...normalizedConfig,
            enabled: true
          }
        }))
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Connect failed'

      if (config.robotId.trim() === robotId) {
        setStatus((current) => ({
          ...current,
          isRunning: false,
          isConnected: false,
          lastError: errorMessage
        }))
      }

      if (robotId) {
        const failedStatus: BackendSimulatorStatus = {
          ...(statusByRobotId[robotId] ?? createDisconnectedBackendSimulatorStatus()),
          isRunning: false,
          isConnected: false,
          lastError: errorMessage
        }

        setStatusByRobotId((current) => ({
          ...current,
          [robotId]: failedStatus
        }))

        setRobotRuntime(robotId, failedStatus)
      }
    }
  }

  const handleConnect = async (): Promise<void> => {
    await handleConnectRobot(config)
  }

  const selectedRobotStatus = config.robotId.trim()
    ? (statusByRobotId[config.robotId.trim()] ?? createDisconnectedBackendSimulatorStatus())
    : status

  const handleDisconnectRobot = (robotId: string): void => {
    const normalizedRobotId = robotId.trim()

    if (!normalizedRobotId) return

    backendDeviceSimulatorManager.stop(normalizedRobotId)

    setConfig((current) =>
      current.robotId.trim() === normalizedRobotId
        ? {
            ...current,
            enabled: false
          }
        : current
    )

    setConfigByRobotId((current) => ({
      ...current,
      [normalizedRobotId]: {
        ...(current[normalizedRobotId] ?? config),
        robotId: normalizedRobotId,
        enabled: false
      }
    }))

    if (config.robotId.trim() === normalizedRobotId) {
      setStatus((current) => ({
        ...current,
        isRunning: false,
        isConnected: false
      }))
    }

    const disconnectedStatus: BackendSimulatorStatus = {
      ...(statusByRobotId[normalizedRobotId] ?? createDisconnectedBackendSimulatorStatus()),
      isRunning: false,
      isConnected: false
    }

    setStatusByRobotId((current) => ({
      ...current,
      [normalizedRobotId]: disconnectedStatus
    }))

    setRobotRuntime(normalizedRobotId, disconnectedStatus)
  }

  const handleDisconnect = (): void => {
    const robotId = config.robotId.trim()

    if (robotId) {
      handleDisconnectRobot(robotId)
      return
    }

    setStatus((current) => ({
      ...current,
      isRunning: false,
      isConnected: false
    }))
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#11131b] font-sans text-slate-100">
      <Header />

      <div className="flex flex-1 overflow-hidden min-h-0">
        <RobotSidebar
          simulatorConfig={config}
          simulatorConfigByRobotId={configByRobotId}
          simulatorStatus={selectedRobotStatus}
          onSimulatorConfigChange={(nextConfig) => {
            setConfig(nextConfig)

            if (nextConfig.robotId.trim()) {
              setConfigByRobotId((current) => ({
                ...current,
                [nextConfig.robotId.trim()]: nextConfig
              }))
            }
          }}
          onSimulatorConnect={handleConnect}
          onSimulatorDisconnect={handleDisconnect}
          onSimulatorConnectRobot={handleConnectRobot}
          onSimulatorDisconnectRobot={handleDisconnectRobot}
        />

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            <Viewport3D />
          </div>
          <BottomConsole />
        </main>

        {workspaceMode === 'train' && (
          <aside className="flex h-full w-[380px] shrink-0 flex-col overflow-hidden border-l border-[#343849] bg-[#141720]">
            <BackendProgramControls />

            <div className="min-h-0 flex-1">
              <WorkflowPanel />
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

export default App
