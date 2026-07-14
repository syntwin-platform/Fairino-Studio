import React from 'react'
import { Link, Link2Off } from 'lucide-react'
import { BackendSimulatorConfig, BackendSimulatorStatus } from '../types/backendDevice'
import { useRobotStore } from '../store/robotStore'

export interface BackendSimulatorPanelProps {
  config: BackendSimulatorConfig
  status: BackendSimulatorStatus
  onConfigChange: (config: BackendSimulatorConfig) => void
  onConnect: () => Promise<void>
  onDisconnect: () => void
}

function formatTime(value?: string): string {
  if (!value) return '-'
  return new Date(value).toLocaleTimeString()
}

export default function BackendSimulatorPanel({
  config,
  status,
  onConfigChange,
  onConnect,
  onDisconnect
}: BackendSimulatorPanelProps): React.ReactElement {
  const cabinetDigitalOutputs = useRobotStore((state) => state.cabinetDigitalOutputs)
  const toolDigitalOutputs = useRobotStore((state) => state.toolDigitalOutputs)
  const gripperState = useRobotStore((state) => state.gripperState)

  const updateConfig = <K extends keyof BackendSimulatorConfig>(
    key: K,
    value: BackendSimulatorConfig[K]
  ): void => {
    onConfigChange({
      ...config,
      [key]: value
    })
  }

  return (
    <div className="flex w-full flex-col text-slate-200 bg-[#1b1b1f] p-4 select-none">
      <div className="min-h-0 flex-1">
        <div className="space-y-4">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Backend URL
            </span>
            <input
              value={config.backendUrl}
              onChange={(event) => updateConfig('backendUrl', event.target.value)}
              disabled={status.isRunning}
              className="mt-1 w-full rounded-md border border-[#2d2d34] bg-[#0c0e16] px-3 py-2 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60 transition"
              placeholder="http://localhost:5200"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Robot ID
            </span>
            <input
              value={config.robotId}
              onChange={(event) => updateConfig('robotId', event.target.value)}
              disabled={status.isRunning}
              className="mt-1 w-full rounded-md border border-[#2d2d34] bg-[#0c0e16] px-3 py-2 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60 transition"
              placeholder="11111111-1111-1111-1111-111111111111"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Device Secret
            </span>
            <input
              value={config.deviceSecret}
              onChange={(event) => updateConfig('deviceSecret', event.target.value)}
              disabled={status.isRunning}
              type="password"
              className="mt-1 w-full rounded-md border border-[#2d2d34] bg-[#0c0e16] px-3 py-2 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60 transition"
              placeholder="raw secret from Backend"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Heartbeat (ms)
              </span>
              <input
                value={config.heartbeatIntervalMs}
                onChange={(event) =>
                  updateConfig('heartbeatIntervalMs', Number(event.target.value))
                }
                disabled={status.isRunning}
                type="number"
                min={1000}
                step={500}
                className="mt-1 w-full rounded-md border border-[#2d2d34] bg-[#0c0e16] px-3 py-2 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60 transition"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Telemetry (ms)
              </span>
              <input
                value={config.telemetryIntervalMs}
                onChange={(event) =>
                  updateConfig('telemetryIntervalMs', Number(event.target.value))
                }
                disabled={status.isRunning}
                type="number"
                min={100}
                step={50}
                className="mt-1 w-full rounded-md border border-[#2d2d34] bg-[#0c0e16] px-3 py-2 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-60 transition"
              />
            </label>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            onClick={() => void onConnect()}
            disabled={status.isRunning}
            className="flex items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 shadow-md"
          >
            <Link size={13} />
            Connect
          </button>

          <button
            onClick={onDisconnect}
            disabled={!status.isRunning}
            className="flex items-center justify-center gap-1.5 rounded-md border border-[#343849] bg-[#242833] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-red-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Link2Off size={13} />
            Disconnect
          </button>
        </div>

        <div className="mt-5 space-y-2 border-t border-[#2d2d34] pt-4 text-[11px] leading-relaxed">
          <div className="flex justify-between">
            <span className="text-slate-400">Running</span>
            <span
              className={
                status.isRunning ? 'text-blue-400 font-bold' : 'text-slate-500 font-medium'
              }
            >
              {status.isRunning ? 'Yes' : 'No'}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Connected</span>
            <span
              className={
                status.isConnected ? 'text-emerald-400 font-bold' : 'text-slate-500 font-medium'
              }
            >
              {status.isConnected ? 'Yes' : 'No'}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Last heartbeat</span>
            <span className="font-mono">{formatTime(status.lastHeartbeatAt)}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Last telemetry</span>
            <span className="font-mono">{formatTime(status.lastTelemetryAt)}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Last command</span>
            <span className="font-mono">{formatTime(status.lastCommandAt)}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Last result</span>
            <span className="font-mono">{formatTime(status.lastResultAt)}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Gripper</span>
            <span className="font-medium text-slate-200">
              {gripperState === 'open' ? 'Open' : 'Closed'}
            </span>
          </div>

          <div className="flex justify-between gap-2">
            <span className="text-slate-400 shrink-0">Cabinet DO</span>
            <span className="text-right font-mono text-slate-300">
              {Object.entries(cabinetDigitalOutputs)
                .map(([index, value]) => `${index}:${value}`)
                .join(', ') || '-'}
            </span>
          </div>

          <div className="flex justify-between gap-2">
            <span className="text-slate-400 shrink-0">Tool DO</span>
            <span className="text-right font-mono text-slate-300">
              {Object.entries(toolDigitalOutputs)
                .map(([index, value]) => `${index}:${value}`)
                .join(', ') || '-'}
            </span>
          </div>

          {status.lastError && (
            <div className="mt-3 rounded-md border border-red-500/30 bg-red-950/20 px-3 py-2 text-red-300 leading-snug">
              {status.lastError}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
