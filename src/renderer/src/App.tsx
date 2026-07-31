import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, LayoutDashboard } from 'lucide-react'
import Header from './components/layout/Header'
import RobotSidebar from './components/robot/RobotSidebar'
import Viewport3D from './components/viewport/Viewport3D'
import WorkflowPanel from './components/workflow/WorkflowPanel'
import BottomConsole from './components/ui/BottomConsole'
import FactoryDashboard from './components/dashboard/FactoryDashboard'
import {
  BACKEND_ENVIRONMENT_OPTIONS,
  BackendSimulatorConfig,
  BackendSimulatorConfigByRobotId,
  BackendSimulatorStatus,
  BackendSimulatorStatusByRobotId,
  CLOUD_STAGING_BACKEND_URL,
  createDisconnectedBackendSimulatorStatus,
  defaultBackendSimulatorConfig,
  defaultRobotRuntimeConfig
} from './types/backendDevice'
import { backendDeviceSimulatorManager } from './services/backendDeviceSimulator'
import { deleteRobot as deleteBackendRobot } from './services/backendRobotClient'
import { getRobotRuntimeConfig as fetchRobotRuntimeConfig } from './services/backendRuntimeConfigClient'
import { setRobotRuntimeConfig } from './services/robotMotionRuntime'
import BackendProgramControls from './components/BackendProgramControls'
import {
  BACKEND_ACCESS_TOKEN_STORAGE_KEY,
  BACKEND_USER_STORAGE_KEY,
  useBackendAuthStore
} from './store/backendAuthStore'
import { useRobotStore } from './store/robotStore'
import { translations } from './i18n/translations'
import {
  BACKEND_SIMULATOR_BY_ROBOT_STORAGE_KEY,
  BACKEND_SIMULATOR_STORAGE_KEY,
  clearSynTwinAccountSession,
  sanitizeBackendSimulatorConfigForLogout
} from './services/accountSession'
import {
  getSavedDeviceSecretsForAccount,
  saveDeviceSecretsForAccount
} from './services/deviceSecretStorage'
import LoginScreen from './components/auth/LoginScreen'

const FACTORY_VIEW_STORAGE_KEY = 'fairobot.factory.view'

type FactoryView = 'overview' | 'scene'

function loadFactoryView(): FactoryView {
  return window.localStorage.getItem(FACTORY_VIEW_STORAGE_KEY) === 'scene' ? 'scene' : 'overview'
}

function loadConfig(): BackendSimulatorConfig {
  try {
    const raw = window.localStorage.getItem(BACKEND_SIMULATOR_STORAGE_KEY)
    if (!raw) return defaultBackendSimulatorConfig

    const savedConfig = JSON.parse(raw) as Partial<BackendSimulatorConfig>
    const backendUrl =
      BACKEND_ENVIRONMENT_OPTIONS.find((option) => option.url === savedConfig.backendUrl)?.url ??
      defaultBackendSimulatorConfig.backendUrl

    const config = {
      ...defaultBackendSimulatorConfig,
      ...savedConfig,
      backendUrl
    }

    return window.sessionStorage.getItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)
      ? config
      : sanitizeBackendSimulatorConfigForLogout(config)
  } catch {
    return defaultBackendSimulatorConfig
  }
}

function loadConfigByRobotId(): BackendSimulatorConfigByRobotId {
  if (!window.sessionStorage.getItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)) {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(BACKEND_SIMULATOR_BY_ROBOT_STORAGE_KEY)
    const baseConfigs: BackendSimulatorConfigByRobotId = raw ? JSON.parse(raw) : {}

    const rawUser = window.sessionStorage.getItem(BACKEND_USER_STORAGE_KEY)
    let accountKey = ''
    if (rawUser) {
      const user = JSON.parse(rawUser) as { id?: string; email?: string }
      accountKey = user.id || user.email || ''
    }

    if (accountKey) {
      const savedSecrets = getSavedDeviceSecretsForAccount(accountKey)
      for (const [robotId, secret] of Object.entries(savedSecrets)) {
        if (secret) {
          baseConfigs[robotId] = {
            ...defaultBackendSimulatorConfig,
            ...(baseConfigs[robotId] ?? {}),
            robotId,
            deviceSecret: secret
          }
        }
      }
    }

    return baseConfigs
  } catch {
    return {}
  }
}

function loadPreferredLoginBackendUrl(): string {
  try {
    const raw = window.localStorage.getItem(BACKEND_SIMULATOR_STORAGE_KEY)
    if (!raw) return CLOUD_STAGING_BACKEND_URL

    const savedConfig = JSON.parse(raw) as Partial<BackendSimulatorConfig>
    return (
      BACKEND_ENVIRONMENT_OPTIONS.find((option) => option.url === savedConfig.backendUrl)?.url ??
      CLOUD_STAGING_BACKEND_URL
    )
  } catch {
    return CLOUD_STAGING_BACKEND_URL
  }
}

async function loadRuntimeConfigForSimulator(
  config: BackendSimulatorConfig
): Promise<string | null> {
  const token = window.sessionStorage.getItem(BACKEND_ACCESS_TOKEN_STORAGE_KEY)

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
  const language = useRobotStore((state) => state.language)
  const selectRobot = useRobotStore((state) => state.selectRobot)
  const removeRobot = useRobotStore((state) => state.removeRobot)
  const accessToken = useBackendAuthStore((state) => state.accessToken)
  const authenticatedUser = useBackendAuthStore((state) => state.user)
  const t = translations[language]
  const [preferredLoginBackendUrl, setPreferredLoginBackendUrl] = useState(() =>
    loadPreferredLoginBackendUrl()
  )
  const [factoryView, setFactoryView] = useState<FactoryView>(() => loadFactoryView())
  const [config, setConfig] = useState<BackendSimulatorConfig>(() => loadConfig())
  const [configByRobotId, setConfigByRobotId] = useState<BackendSimulatorConfigByRobotId>(() =>
    loadConfigByRobotId()
  )
  const [status, setStatus] = useState<BackendSimulatorStatus>({
    isRunning: false,
    isConnected: false
  })
  const [statusByRobotId, setStatusByRobotId] = useState<BackendSimulatorStatusByRobotId>({})
  const previousAccessTokenRef = useRef(accessToken)

  const handleAccountLogout = useCallback((): void => {
    previousAccessTokenRef.current = ''
    clearSynTwinAccountSession()
    setConfig((current) => sanitizeBackendSimulatorConfigForLogout(current))
    setConfigByRobotId({})
    setStatus(createDisconnectedBackendSimulatorStatus())
    setStatusByRobotId({})
  }, [])

  const handleAuthenticated = useCallback((backendUrl: string): void => {
    setPreferredLoginBackendUrl(backendUrl)
    setConfig((current) => ({
      ...sanitizeBackendSimulatorConfigForLogout(current),
      backendUrl
    }))
  }, [])

  useEffect(() => {
    window.localStorage.setItem(BACKEND_SIMULATOR_STORAGE_KEY, JSON.stringify(config))
  }, [config])

  useEffect(() => {
    window.localStorage.setItem(
      BACKEND_SIMULATOR_BY_ROBOT_STORAGE_KEY,
      JSON.stringify(configByRobotId)
    )

    const userKeys = [authenticatedUser?.id, authenticatedUser?.email].filter(
      (k): k is string => Boolean(k?.trim())
    )
    if (userKeys.length === 0) return

    const secretsToSave: Record<string, string> = {}
    for (const [robotId, cfg] of Object.entries(configByRobotId)) {
      if (cfg?.deviceSecret?.trim()) {
        secretsToSave[robotId] = cfg.deviceSecret.trim()
      }
    }

    if (Object.keys(secretsToSave).length > 0) {
      for (const key of userKeys) {
        saveDeviceSecretsForAccount(key, secretsToSave)
      }
    }
  }, [configByRobotId, authenticatedUser])

  useEffect(() => {
    const userKeys = [authenticatedUser?.id, authenticatedUser?.email].filter(
      (k): k is string => Boolean(k?.trim())
    )
    if (userKeys.length === 0) return

    let savedSecrets: Record<string, string> = {}
    for (const key of userKeys) {
      savedSecrets = { ...savedSecrets, ...getSavedDeviceSecretsForAccount(key) }
    }

    if (Object.keys(savedSecrets).length === 0) return

    setConfigByRobotId((current) => {
      let updated = false
      const next = { ...current }

      for (const [robotId, secret] of Object.entries(savedSecrets)) {
        if (secret && next[robotId]?.deviceSecret !== secret) {
          next[robotId] = {
            ...defaultBackendSimulatorConfig,
            ...(next[robotId] ?? {}),
            robotId,
            deviceSecret: secret
          }
          updated = true
        }
      }

      return updated ? next : current
    })
  }, [authenticatedUser])

  useEffect(() => {
    const previousAccessToken = previousAccessTokenRef.current
    previousAccessTokenRef.current = accessToken

    if (previousAccessToken && !accessToken) {
      handleAccountLogout()
    }
  }, [accessToken, handleAccountLogout])

  useEffect(() => {
    window.localStorage.setItem(FACTORY_VIEW_STORAGE_KEY, factoryView)
  }, [factoryView])

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

  const handleDeleteRobot = async (robotId: string): Promise<void> => {
    const normalizedRobotId = robotId.trim()
    if (!normalizedRobotId) return

    const currentStore = useRobotStore.getState()
    const runtime =
      statusByRobotId[normalizedRobotId] ?? currentStore.robotRuntimeById[normalizedRobotId]
    const execution = currentStore.robotExecutionById[normalizedRobotId]

    if (runtime?.isConnected || runtime?.isRunning || execution?.isPlaying) {
      throw new Error(t.deleteRobotBlocked)
    }

    if (!accessToken.trim()) {
      throw new Error(t.notSignedIn)
    }

    const backendUrl = (configByRobotId[normalizedRobotId]?.backendUrl || config.backendUrl).trim()

    await deleteBackendRobot(backendUrl, accessToken, normalizedRobotId)

    backendDeviceSimulatorManager.stop(normalizedRobotId)
    removeRobot(normalizedRobotId)

    setConfigByRobotId((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([savedRobotId]) => savedRobotId !== normalizedRobotId)
      )
    )
    setStatusByRobotId((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([savedRobotId]) => savedRobotId !== normalizedRobotId)
      )
    )

    if (config.robotId.trim() === normalizedRobotId) {
      setConfig((current) => ({
        ...current,
        robotId: '',
        deviceSecret: '',
        enabled: false
      }))
      setStatus(createDisconnectedBackendSimulatorStatus())
    }
  }

  if (!accessToken || !authenticatedUser) {
    return (
      <LoginScreen
        initialBackendUrl={preferredLoginBackendUrl}
        onAuthenticated={handleAuthenticated}
      />
    )
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#11131b] font-sans text-slate-100">
      <Header onLogout={handleAccountLogout} />

      {workspaceMode === 'factory' && (
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#2b3040] bg-[#151821] px-4">
          <div className="flex items-center gap-1 rounded-lg border border-[#303545] bg-[#10131b] p-1">
            <button
              type="button"
              onClick={() => setFactoryView('overview')}
              className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                factoryView === 'overview'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-400 hover:bg-[#242938] hover:text-slate-100'
              }`}
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              {t.factoryDashboard}
            </button>

            <button
              type="button"
              onClick={() => setFactoryView('scene')}
              className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                factoryView === 'scene'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-400 hover:bg-[#242938] hover:text-slate-100'
              }`}
            >
              <Box className="h-3.5 w-3.5" />
              {t.factory3dView}
            </button>
          </div>

          <span className="hidden text-[11px] uppercase tracking-[0.14em] text-slate-500 sm:block">
            {t.viewMode}
          </span>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden min-h-0">
        <div
          className={
            workspaceMode === 'factory' && factoryView === 'overview' ? 'hidden' : 'contents'
          }
        >
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
            onSimulatorConfigsImport={(importedConfigs) => {
              setConfigByRobotId((current) => ({
                ...current,
                ...importedConfigs
              }))
            }}
            onSimulatorConnectRobot={handleConnectRobot}
            onSimulatorDisconnectRobot={handleDisconnectRobot}
          />
        </div>

        {workspaceMode === 'factory' && factoryView === 'overview' && (
          <FactoryDashboard
            simulatorConfig={config}
            simulatorConfigByRobotId={configByRobotId}
            onConnectRobot={handleConnectRobot}
            onDisconnectRobot={handleDisconnectRobot}
            onDeleteRobot={handleDeleteRobot}
            onOpenScene={(robotId) => {
              selectRobot(robotId)
              setFactoryView('scene')
            }}
          />
        )}

        <main
          className={
            workspaceMode === 'factory' && factoryView === 'overview'
              ? 'hidden'
              : 'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
          }
        >
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
