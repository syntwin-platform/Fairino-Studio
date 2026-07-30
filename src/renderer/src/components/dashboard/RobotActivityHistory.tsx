import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  History,
  Radio,
  RefreshCw,
  Terminal
} from 'lucide-react'
import { translations, type TranslationKeys } from '../../i18n/translations'
import { listRobotCommands, type BackendCommandResponse } from '../../services/backendProgramClient'
import {
  getRobotTelemetryHistory,
  type RobotTelemetryHistoryPoint
} from '../../services/backendTelemetryHistoryClient'
import {
  buildRobotActivityEvents,
  type RobotActivityEvent,
  type RobotActivityKind
} from '../../services/robotActivityHistory'
import { useRobotStore } from '../../store/robotStore'
import type { BackendSimulatorStatus } from '../../types/backendDevice'

type ActivityFilter = 'all' | 'command' | 'telemetry' | 'system'

interface RobotActivityHistoryProps {
  backendUrl: string
  robotId: string
  token: string
  runtime?: BackendSimulatorStatus
}

function eventTone(event: RobotActivityEvent): string {
  if (event.collisionWarning || ['Failed', 'Timeout', 'Cancelled'].includes(event.status ?? '')) {
    return 'border-rose-500/25 bg-rose-500/10 text-rose-300'
  }

  if (event.status === 'Completed' || event.status === 'Online') {
    return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
  }

  return 'border-sky-500/20 bg-sky-500/10 text-sky-300'
}

function EventIcon({ kind }: { kind: RobotActivityKind }): React.JSX.Element {
  if (kind === 'command') return <Terminal className="h-4 w-4" />
  if (kind === 'telemetry') return <Activity className="h-4 w-4" />
  if (kind === 'heartbeat') return <Radio className="h-4 w-4" />
  return <CheckCircle2 className="h-4 w-4" />
}

export default function RobotActivityHistory({
  backendUrl,
  robotId,
  token,
  runtime
}: RobotActivityHistoryProps): React.JSX.Element {
  const language = useRobotStore((state) => state.language)
  const [commands, setCommands] = useState<BackendCommandResponse[]>([])
  const [telemetry, setTelemetry] = useState<RobotTelemetryHistoryPoint[]>([])
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [loading, setLoading] = useState(false)
  const [partialHistory, setPartialHistory] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const t = (key: TranslationKeys): string => translations[language][key]

  const loadHistory = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!backendUrl.trim() || !robotId.trim() || !token.trim()) {
        setCommands([])
        setTelemetry([])
        setPartialHistory(false)
        setLoadFailed(false)
        return
      }

      setLoading(true)
      setLoadFailed(false)

      const to = new Date()
      const from = new Date(to.getTime() - 24 * 60 * 60 * 1000)
      const [commandsResult, telemetryResult] = await Promise.allSettled([
        listRobotCommands({ backendUrl, token }, robotId, signal),
        getRobotTelemetryHistory(
          backendUrl,
          robotId,
          token,
          {
            from: from.toISOString(),
            to: to.toISOString(),
            intervalSeconds: 15,
            limit: 80,
            fields: [
              'jointAngles',
              'tcpPose',
              'sequenceNumber',
              'latencyMilliseconds',
              'collisionWarning',
              'status',
              'source'
            ]
          },
          signal
        )
      ])

      if (signal?.aborted) return

      if (commandsResult.status === 'fulfilled') {
        setCommands(commandsResult.value)
      } else {
        setCommands([])
      }

      if (telemetryResult.status === 'fulfilled') {
        setTelemetry(telemetryResult.value)
      } else {
        setTelemetry([])
      }

      const failedCount =
        Number(commandsResult.status === 'rejected') + Number(telemetryResult.status === 'rejected')

      setPartialHistory(failedCount === 1)
      setLoadFailed(failedCount === 2)
      setLoading(false)
    },
    [backendUrl, robotId, token]
  )

  useEffect(() => {
    const controller = new AbortController()
    void loadHistory(controller.signal)

    return () => controller.abort()
  }, [loadHistory])

  const events = useMemo(
    () =>
      buildRobotActivityEvents({
        commands,
        telemetry,
        runtime,
        limit: 80
      }),
    [commands, runtime, telemetry]
  )

  const filteredEvents = useMemo(
    () =>
      events.filter((event) => {
        if (filter === 'all') return true
        if (filter === 'command') return event.kind === 'command' || event.kind === 'result'
        if (filter === 'telemetry') return event.kind === 'telemetry'
        return event.kind === 'heartbeat'
      }),
    [events, filter]
  )

  const formatTimestamp = (value: string): string => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value

    return new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit'
    }).format(date)
  }

  const eventTitle = (event: RobotActivityEvent): string => {
    if (event.kind === 'command') {
      return event.label ? `${t('commandActivity')}: ${event.label}` : t('commandActivity')
    }
    if (event.kind === 'telemetry') return t('telemetryActivity')
    if (event.kind === 'heartbeat') return t('heartbeatActivity')
    return t('commandResultActivity')
  }

  const eventDetails = (event: RobotActivityEvent): string[] => {
    const details: string[] = []

    if (event.status) details.push(event.status)
    if (typeof event.sequenceNumber === 'number') {
      details.push(`${t('sequenceShort')} #${event.sequenceNumber}`)
    }
    if (typeof event.latencyMilliseconds === 'number') {
      details.push(`${event.latencyMilliseconds.toFixed(1)} ms`)
    }
    if (event.collisionWarning) details.push(t('warning'))
    if (event.detail) details.push(event.detail)

    return details
  }

  const filters: { value: ActivityFilter; label: string }[] = [
    { value: 'all', label: t('allActivity') },
    { value: 'command', label: t('commandActivity') },
    { value: 'telemetry', label: t('telemetryActivity') },
    { value: 'system', label: t('systemActivity') }
  ]

  return (
    <div className="rounded-2xl border border-[#2a3040] bg-[#111520] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
            <History className="h-4 w-4 text-sky-300" />
            {t('activityHistory')}
          </h3>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            {t('activityHistorySubtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadHistory()}
          disabled={loading}
          title={t('refresh')}
          className="rounded-lg border border-[#303747] p-2 text-slate-400 transition hover:border-sky-500/30 hover:bg-sky-500/10 hover:text-sky-300 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="mt-3 flex gap-1 overflow-x-auto rounded-lg bg-[#0d111a] p-1">
        {filters.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setFilter(item.value)}
            className={`shrink-0 rounded-md px-2.5 py-1.5 text-[10px] font-semibold transition ${
              filter === item.value
                ? 'bg-sky-500/15 text-sky-200'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {(partialHistory || loadFailed) && (
        <div
          className={`mt-3 flex gap-2 rounded-xl border px-3 py-2 text-[11px] leading-relaxed ${
            loadFailed
              ? 'border-rose-500/25 bg-rose-500/[0.06] text-rose-200'
              : 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200'
          }`}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{loadFailed ? t('historyLoadFailed') : t('historyPartial')}</span>
        </div>
      )}

      <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
        {filteredEvents.length === 0 && !loading ? (
          <div className="flex min-h-28 flex-col items-center justify-center rounded-xl border border-dashed border-[#303747] px-4 text-center">
            <CircleDot className="h-5 w-5 text-slate-700" />
            <p className="mt-2 text-xs text-slate-500">{t('noActivityHistory')}</p>
          </div>
        ) : (
          filteredEvents.map((event) => {
            const details = eventDetails(event)

            return (
              <div
                key={event.id}
                className="flex gap-3 rounded-xl border border-[#252b38] bg-[#171b26] p-3"
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${eventTone(event)}`}
                >
                  <EventIcon kind={event.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="truncate text-xs font-semibold text-slate-200">
                      {eventTitle(event)}
                    </p>
                    <span className="shrink-0 text-[10px] text-slate-600">
                      {formatTimestamp(event.timestamp)}
                    </span>
                  </div>
                  {details.length > 0 && (
                    <p className="mt-1 truncate text-[10px] text-slate-500">
                      {details.join(' · ')}
                    </p>
                  )}
                  <p className="mt-1 text-[9px] uppercase tracking-wider text-slate-600">
                    {event.source === 'cloud' ? t('cloudHistory') : t('currentSession')}
                  </p>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
