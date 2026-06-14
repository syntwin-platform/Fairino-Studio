import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Link, Link2Off, Server } from 'lucide-react'
import {
  BackendSimulatorConfig,
  BackendSimulatorStatus,
  defaultBackendSimulatorConfig
} from '../types/backendDevice'
import { backendDeviceSimulator } from '../services/backendDeviceSimulator'
import { useRobotStore } from '../store/robotStore'

const STORAGE_KEY = 'syntwin.backendSimulator.config'

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

function formatTime(value?: string): string {
  if (!value) return '-'
  return new Date(value).toLocaleTimeString()
}

function statusLabel(status: BackendSimulatorStatus): string {
  if (status.isConnected) return 'Online'
  if (status.isRunning) return 'Connecting'
  return 'Offline'
}

export default function BackendSimulatorPanel(): React.JSX.Element {
  const [config, setConfig] = useState<BackendSimulatorConfig>(() => loadConfig())
  const [status, setStatus] = useState<BackendSimulatorStatus>({
    isRunning: false,
    isConnected: false
  })
  const [isOpen, setIsOpen] = useState(false)

  const cabinetDigitalOutputs = useRobotStore(
    (state) => state.cabinetDigitalOutputs
  )

  const toolDigitalOutputs = useRobotStore(
    (state) => state.toolDigitalOutputs
  )

  const gripperState = useRobotStore(
    (state) => state.gripperState
  )

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  }, [config])

  useEffect(() => {
    return () => {
      backendDeviceSimulator.stop()
    }
  }, [])

  const updateConfig = <K extends keyof BackendSimulatorConfig>(
    key: K,
    value: BackendSimulatorConfig[K]
  ): void => {
    setConfig((current) => ({
      ...current,
      [key]: value
    }))
  }

  const handleConnect = (): void => {
    try {
      backendDeviceSimulator.start(
        {
          ...config,
          enabled: true
        },
        {
          onStatusChange: (partial) => {
            setStatus((current) => ({
              ...current,
              ...partial
            }))
          }
        }
      )

      setConfig((current) => ({
        ...current,
        enabled: true
      }))
    } catch (error) {
      setStatus((current) => ({
        ...current,
        isRunning: false,
        isConnected: false,
        lastError: error instanceof Error ? error.message : 'Connect failed'
      }))
    }
  }

  const handleDisconnect = (): void => {
    backendDeviceSimulator.stop()

    setConfig((current) => ({
      ...current,
      enabled: false
    }))

    setStatus((current) => ({
      ...current,
      isRunning: false,
      isConnected: false
    }))
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="absolute bottom-4 left-4 z-20 flex h-10 items-center gap-2 rounded border border-[#2d2d34] bg-[#141417]/95 px-3 text-xs font-semibold text-slate-200 shadow-lg backdrop-blur transition hover:border-blue-500 hover:text-white"
        title="Open Backend Simulator"
      >
        <span
          className={`h-2.5 w-2.5 rounded-full ${status.isConnected
              ? 'bg-emerald-400'
              : status.isRunning
                ? 'bg-amber-400'
                : 'bg-slate-500'
            }`}
        />
        <Server size={14} className="text-blue-400" />
        <span>Backend</span>
        <span className="rounded bg-[#0f0f12] px-1.5 py-0.5 text-[10px] text-slate-400">
          {statusLabel(status)}
        </span>
        <ChevronUp size={14} className="text-slate-500" />
      </button>
    )
  }

  return (
    <div className="absolute bottom-4 left-4 z-20 flex max-h-[calc(100%_-_2rem)] w-72 flex-col overflow-hidden rounded border border-[#2d2d34] bg-[#141417]/95 text-slate-200 shadow-xl backdrop-blur">
      <button
        onClick={() => setIsOpen(false)}
        className="flex w-full shrink-0 items-center justify-between border-b border-[#2d2d34] px-3 py-2 text-left transition hover:bg-[#1e1e24]"
        title="Collapse Backend Simulator"
      >
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${status.isConnected
                ? 'bg-emerald-400'
                : status.isRunning
                  ? 'bg-amber-400'
                  : 'bg-slate-500'
              }`}
          />
          <Server size={14} className="text-blue-400" />
          <div>
            <h3 className="text-xs font-bold text-white">Backend Simulator</h3>
            <p className="text-[10px] text-slate-500">{statusLabel(status)}</p>
          </div>
        </div>
        <ChevronDown size={15} className="text-slate-500" />
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="space-y-2">
          <label className="block">
            <span className="text-[10px] font-semibold uppercase text-slate-400">Backend URL</span>
            <input
              value={config.backendUrl}
              onChange={(event) => updateConfig('backendUrl', event.target.value)}
              disabled={status.isRunning}
              className="mt-1 w-full rounded border border-[#2d2d34] bg-[#0f0f12] px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60"
              placeholder="http://localhost:5200"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-semibold uppercase text-slate-400">Robot ID</span>
            <input
              value={config.robotId}
              onChange={(event) => updateConfig('robotId', event.target.value)}
              disabled={status.isRunning}
              className="mt-1 w-full rounded border border-[#2d2d34] bg-[#0f0f12] px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60"
              placeholder="11111111-1111-1111-1111-111111111111"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-semibold uppercase text-slate-400">
              Device Secret
            </span>
            <input
              value={config.deviceSecret}
              onChange={(event) => updateConfig('deviceSecret', event.target.value)}
              disabled={status.isRunning}
              type="password"
              className="mt-1 w-full rounded border border-[#2d2d34] bg-[#0f0f12] px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60"
              placeholder="raw secret from Backend"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase text-slate-400">Heartbeat</span>
              <input
                value={config.heartbeatIntervalMs}
                onChange={(event) =>
                  updateConfig('heartbeatIntervalMs', Number(event.target.value))
                }
                disabled={status.isRunning}
                type="number"
                min={1000}
                step={500}
                className="mt-1 w-full rounded border border-[#2d2d34] bg-[#0f0f12] px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-semibold uppercase text-slate-400">Telemetry</span>
              <input
                value={config.telemetryIntervalMs}
                onChange={(event) =>
                  updateConfig('telemetryIntervalMs', Number(event.target.value))
                }
                disabled={status.isRunning}
                type="number"
                min={100}
                step={50}
                className="mt-1 w-full rounded border border-[#2d2d34] bg-[#0f0f12] px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-semibold uppercase text-slate-400">Poll</span>
              <input
                value={config.commandPollIntervalMs}
                onChange={(event) =>
                  updateConfig('commandPollIntervalMs', Number(event.target.value))
                }
                disabled={status.isRunning}
                type="number"
                min={300}
                step={100}
                className="mt-1 w-full rounded border border-[#2d2d34] bg-[#0f0f12] px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60"
              />
            </label>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={handleConnect}
            disabled={status.isRunning}
            className="flex items-center justify-center gap-1.5 rounded bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Link size={14} />
            Connect
          </button>

          <button
            onClick={handleDisconnect}
            disabled={!status.isRunning}
            className="flex items-center justify-center gap-1.5 rounded border border-[#393942] bg-[#1e1e24] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-red-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Link2Off size={14} />
            Disconnect
          </button>
        </div>

        <div className="mt-3 space-y-1 border-t border-[#2d2d34] pt-3 text-[11px]">
          <div className="flex justify-between">
            <span className="text-slate-400">Running</span>
            <span>{status.isRunning ? 'Yes' : 'No'}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Connected</span>
            <span>{status.isConnected ? 'Yes' : 'No'}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Last heartbeat</span>
            <span>{formatTime(status.lastHeartbeatAt)}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Last telemetry</span>
            <span>{formatTime(status.lastTelemetryAt)}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Last command</span>
            <span>{formatTime(status.lastCommandAt)}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Last result</span>
            <span>{formatTime(status.lastResultAt)}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Gripper</span>
            <span>{gripperState === 'open' ? 'Open' : 'Closed'}</span>
          </div>

          <div className="flex justify-between gap-2">
            <span className="text-slate-400">Cabinet DO</span>
            <span className="text-right">
              {Object.entries(cabinetDigitalOutputs)
                .map(([index, value]) => `${index}:${value}`)
                .join(', ') || '-'}
            </span>
          </div>

          <div className="flex justify-between gap-2">
            <span className="text-slate-400">Tool DO</span>
            <span className="text-right">
              {Object.entries(toolDigitalOutputs)
                .map(([index, value]) => `${index}:${value}`)
                .join(', ') || '-'}
            </span>
          </div>

          {status.lastError && (
            <div className="mt-2 rounded border border-red-500/40 bg-red-950/30 px-2 py-1.5 text-red-200">
              {status.lastError}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
