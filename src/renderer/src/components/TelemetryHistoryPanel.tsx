import { useEffect, useMemo, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import {
  getRobotTelemetryHistory,
  type RobotTelemetryHistoryPoint
} from '../services/backendTelemetryHistoryClient'

interface TelemetryHistoryPanelProps {
  backendUrl: string
  robotId: string
  token: string
  runtimeSessionId?: string | null
}

function formatTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function formatJointAngles(point: RobotTelemetryHistoryPoint): string {
  return point.jointAngles.length >= 6
    ? point.jointAngles.map((value) => value.toFixed(1)).join(', ')
    : '-'
}

function formatTcp(point: RobotTelemetryHistoryPoint): string {
  if (!point.tcpPose) {
    return '-'
  }

  return [
    point.tcpPose.x,
    point.tcpPose.y,
    point.tcpPose.z,
    point.tcpPose.rx,
    point.tcpPose.ry,
    point.tcpPose.rz
  ]
    .map((value) => value.toFixed(1))
    .join(', ')
}

export default function TelemetryHistoryPanel({
  backendUrl,
  robotId,
  token,
  runtimeSessionId
}: TelemetryHistoryPanelProps): React.ReactElement {
  const [points, setPoints] = useState<RobotTelemetryHistoryPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [rangeMinutes, setRangeMinutes] = useState(60)
  const [limit, setLimit] = useState(300)

  const queryWindow = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - rangeMinutes * 60 * 1000)

    return {
      from: from.toISOString(),
      to: to.toISOString()
    }
  }, [rangeMinutes])

  const loadHistory = async (): Promise<void> => {
    setLoading(true)
    setError('')

    try {
      const result = await getRobotTelemetryHistory(backendUrl, robotId, token, {
        from: queryWindow.from,
        to: queryWindow.to,
        intervalSeconds: 5,
        limit,
        runtimeSessionId
      })

      setPoints(result)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load telemetry history.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, robotId, token, runtimeSessionId, rangeMinutes, limit])

  return (
    <div className="flex h-[62vh] flex-col text-slate-200">
      <div className="mb-3 grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Range
          </span>
          <select
            value={rangeMinutes}
            onChange={(event) => setRangeMinutes(Number(event.target.value))}
            className="mt-1 w-full rounded border border-[#343849] bg-[#0c0e16] px-2 py-1.5 text-xs text-white outline-none"
          >
            <option value={15}>15 min</option>
            <option value={60}>1 hour</option>
            <option value={360}>6 hours</option>
            <option value={1440}>24 hours</option>
          </select>
        </label>

        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Limit
          </span>
          <input
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            type="number"
            min={10}
            max={10000}
            step={50}
            className="mt-1 w-full rounded border border-[#343849] bg-[#0c0e16] px-2 py-1.5 text-xs text-white outline-none"
          />
        </label>

        <button
          type="button"
          onClick={() => void loadHistory()}
          disabled={loading}
          className="mt-5 flex items-center justify-center gap-1.5 rounded border border-[#343849] bg-[#242833] px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-[#2d313f] disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="mb-3 rounded border border-[#343849] bg-[#10131b] px-3 py-2 text-[11px] text-slate-400">
        <div>
          Robot ID: <span className="font-mono text-slate-200">{robotId}</span>
        </div>
        <div>
          Runtime Session:{' '}
          <span className="font-mono text-slate-200">{runtimeSessionId || 'All sessions'}</span>
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded border border-red-500/30 bg-red-950/20 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[#343849] bg-[#0c0e16]">
        {points.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-xs text-slate-500">
            <Activity size={22} className="text-slate-600" />
            No telemetry history found.
          </div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-[#141720] text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Joints</th>
                <th className="px-3 py-2">TCP</th>
                <th className="px-3 py-2">Temp</th>
                <th className="px-3 py-2">Collision</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point, index) => (
                <tr
                  key={`${point.timestamp}-${index}`}
                  className="border-t border-[#242833] text-slate-300"
                >
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px]">
                    {formatTime(point.timestamp)}
                  </td>
                  <td className="px-3 py-2">{point.status || '-'}</td>
                  <td className="max-w-[220px] truncate px-3 py-2 font-mono text-[10px]">
                    {formatJointAngles(point)}
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-2 font-mono text-[10px]">
                    {formatTcp(point)}
                  </td>
                  <td className="px-3 py-2">
                    {typeof point.temperature === 'number' ? point.temperature.toFixed(1) : '-'}
                  </td>
                  <td className="px-3 py-2">
                    {point.collisionWarning ? (
                      <span className="text-red-300">Yes</span>
                    ) : (
                      <span className="text-emerald-300">No</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
