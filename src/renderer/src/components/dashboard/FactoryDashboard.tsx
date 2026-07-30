import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Cloud,
  Cpu,
  Eye,
  Gauge,
  Link2,
  LoaderCircle,
  Monitor,
  Play,
  Power,
  Search,
  Server,
  Trash2,
  Unplug,
  X
} from 'lucide-react'
import { translations, type TranslationKeys } from '../../i18n/translations'
import { useBackendAuthStore } from '../../store/backendAuthStore'
import { useRobotStore, type RobotExecutionState } from '../../store/robotStore'
import type {
  BackendSimulatorConfig,
  BackendSimulatorConfigByRobotId,
  BackendSimulatorStatus
} from '../../types/backendDevice'
import type { RobotInstance } from '../../types/robot.types'
import RobotActivityHistory from './RobotActivityHistory'

type FleetStatus = 'running' | 'online' | 'ready' | 'connecting' | 'error' | 'offline'

interface FleetRobot {
  robot: RobotInstance
  runtime?: BackendSimulatorStatus
  execution?: RobotExecutionState
  config: BackendSimulatorConfig
  status: FleetStatus
  lastActivity: string | null
}

interface FactoryDashboardProps {
  simulatorConfig: BackendSimulatorConfig
  simulatorConfigByRobotId: BackendSimulatorConfigByRobotId
  onConnectRobot: (config: BackendSimulatorConfig) => Promise<void>
  onDisconnectRobot: (robotId: string) => void
  onDeleteRobot: (robotId: string) => Promise<void>
  onOpenScene: (robotId: string) => void
}

const STATUS_STYLES: Record<
  FleetStatus,
  { dot: string; badge: string; border: string; icon: typeof CircleDot }
> = {
  running: {
    dot: 'bg-violet-400',
    badge: 'border-violet-500/30 bg-violet-500/10 text-violet-200',
    border: 'border-violet-500/30',
    icon: Play
  },
  online: {
    dot: 'bg-emerald-400',
    badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    border: 'border-emerald-500/30',
    icon: CheckCircle2
  },
  ready: {
    dot: 'bg-sky-400',
    badge: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
    border: 'border-sky-500/30',
    icon: Link2
  },
  connecting: {
    dot: 'bg-amber-400',
    badge: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    border: 'border-amber-500/30',
    icon: LoaderCircle
  },
  error: {
    dot: 'bg-rose-400',
    badge: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
    border: 'border-rose-500/30',
    icon: AlertTriangle
  },
  offline: {
    dot: 'bg-slate-500',
    badge: 'border-slate-600 bg-slate-800/70 text-slate-300',
    border: 'border-slate-700',
    icon: Unplug
  }
}

function getLatestActivity(runtime?: BackendSimulatorStatus): string | null {
  const timestamps = [
    runtime?.lastHeartbeatAt,
    runtime?.lastTelemetryAt,
    runtime?.lastCommandAt,
    runtime?.lastResultAt
  ].filter((value): value is string => Boolean(value))

  if (timestamps.length === 0) return null

  return timestamps.reduce((latest, current) =>
    new Date(current).getTime() > new Date(latest).getTime() ? current : latest
  )
}

function isTelemetryFresh(item: FleetRobot): boolean {
  if (!item.runtime?.lastTelemetryAt) return false

  const timestamp = new Date(item.runtime.lastTelemetryAt).getTime()
  if (Number.isNaN(timestamp)) return false

  const freshnessWindowMs = Math.max(5_000, item.config.telemetryIntervalMs * 6)
  return Date.now() - timestamp <= freshnessWindowMs
}

function median(values: number[]): number | null {
  if (values.length === 0) return null

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function countActiveOutputs(outputs?: Record<number, boolean>): number {
  return outputs ? Object.values(outputs).filter(Boolean).length : 0
}

function resolveStatus(
  runtime: BackendSimulatorStatus | undefined,
  execution: RobotExecutionState | undefined,
  config: BackendSimulatorConfig
): FleetStatus {
  if (execution?.lastError || (runtime?.lastError && !runtime.isConnected)) return 'error'
  if (execution?.isPlaying) return 'running'
  if (runtime?.isConnected) return 'online'
  if (runtime?.isRunning) return 'connecting'
  if (config.deviceSecret.trim()) return 'ready'
  return 'offline'
}

function StatusBadge({ status, label }: { status: FleetStatus; label: string }): React.JSX.Element {
  const style = STATUS_STYLES[status]
  const Icon = style.icon

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${style.badge}`}
    >
      <Icon className={`h-3.5 w-3.5 ${status === 'connecting' ? 'animate-spin' : ''}`} />
      {label}
    </span>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone
}: {
  icon: typeof Bot
  label: string
  value: number
  detail: string
  tone: 'blue' | 'green' | 'violet' | 'amber' | 'rose'
}): React.JSX.Element {
  const tones = {
    blue: 'border-sky-500/20 bg-sky-500/10 text-sky-300',
    green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
    violet: 'border-violet-500/20 bg-violet-500/10 text-violet-300',
    amber: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
    rose: 'border-rose-500/20 bg-rose-500/10 text-rose-300'
  }

  return (
    <div className="rounded-2xl border border-[#2a3040] bg-[#171b26] p-4 shadow-[0_14px_40px_rgba(0,0,0,0.18)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-slate-400">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-white">{value}</p>
        </div>
        <div className={`rounded-xl border p-2.5 ${tones[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-3 truncate text-[11px] text-slate-500">{detail}</p>
    </div>
  )
}

function LiveMetric({
  icon: Icon,
  label,
  value,
  tone = 'sky'
}: {
  icon: typeof Bot
  label: string
  value: string
  tone?: 'sky' | 'emerald' | 'amber' | 'rose'
}): React.JSX.Element {
  const tones = {
    sky: 'bg-sky-500/10 text-sky-300',
    emerald: 'bg-emerald-500/10 text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-300',
    rose: 'bg-rose-500/10 text-rose-300'
  }

  return (
    <div className="rounded-xl border border-[#2a3040] bg-[#111520] p-3">
      <div className="flex items-center gap-2">
        <span className={`rounded-lg p-2 ${tones[tone]}`}>
          <Icon className="h-4 w-4" />
        </span>
        <p className="text-[11px] font-medium text-slate-500">{label}</p>
      </div>
      <p className="mt-3 text-xl font-semibold tracking-tight text-white">{value}</p>
    </div>
  )
}

function TelemetrySparkline({
  values,
  emptyLabel
}: {
  values: number[]
  emptyLabel: string
}): React.JSX.Element {
  if (values.length < 2) {
    return (
      <div className="flex h-28 items-center justify-center rounded-xl border border-dashed border-[#303747] bg-[#111520]/60 px-4 text-center text-xs text-slate-500">
        {emptyLabel}
      </div>
    )
  }

  const width = 420
  const height = 112
  const inset = 8
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(1, max - min)
  const points = values
    .map((value, index) => {
      const x = inset + (index / (values.length - 1)) * (width - inset * 2)
      const y = height - inset - ((value - min) / range) * (height - inset * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <div className="relative h-28 overflow-hidden rounded-xl border border-[#2a3040] bg-[#111520]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_49%,rgba(100,116,139,0.08)_50%,transparent_51%)] bg-[length:100%_36px]" />
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="relative h-full w-full"
        aria-hidden="true"
      >
        <polyline
          points={points}
          fill="none"
          stroke="rgb(56 189 248)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="absolute bottom-2 right-2 rounded bg-[#0d111a]/80 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
        {values.at(-1)?.toFixed(1)} ms
      </span>
    </div>
  )
}

export default function FactoryDashboard({
  simulatorConfig,
  simulatorConfigByRobotId,
  onConnectRobot,
  onDisconnectRobot,
  onDeleteRobot,
  onOpenScene
}: FactoryDashboardProps): React.JSX.Element {
  const robots = useRobotStore((state) => state.robots)
  const runtimeById = useRobotStore((state) => state.robotRuntimeById)
  const executionById = useRobotStore((state) => state.robotExecutionById)
  const language = useRobotStore((state) => state.language)
  const connectivity = useBackendAuthStore((state) => state.connectivity)
  const accessToken = useBackendAuthStore((state) => state.accessToken)
  const connectionError = useBackendAuthStore((state) => state.connectionError)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<FleetStatus | 'all'>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [detailRobotId, setDetailRobotId] = useState<string | null>(null)
  const [technicalDetailsOpen, setTechnicalDetailsOpen] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const t = (key: TranslationKeys): string => translations[language][key]

  useEffect(() => {
    if (accessToken) return

    setSearch('')
    setStatusFilter('all')
    setSelectedIds([])
    setDetailRobotId(null)
    setTechnicalDetailsOpen(false)
    setActionPending(false)
    setDeleteCandidateId(null)
    setDeletePending(false)
    setDeleteError('')
  }, [accessToken])

  const fleet = useMemo<FleetRobot[]>(
    () =>
      robots.map((robot) => {
        const savedConfig = simulatorConfigByRobotId[robot.id]
        const isCurrentConfig = simulatorConfig.robotId.trim() === robot.id
        const config: BackendSimulatorConfig = {
          ...simulatorConfig,
          ...savedConfig,
          robotId: robot.id,
          deviceSecret:
            savedConfig?.deviceSecret ?? (isCurrentConfig ? simulatorConfig.deviceSecret : ''),
          enabled: savedConfig?.enabled ?? (isCurrentConfig ? simulatorConfig.enabled : false)
        }
        const runtime = runtimeById[robot.id]
        const execution = executionById[robot.id]

        return {
          robot,
          runtime,
          execution,
          config,
          status: resolveStatus(runtime, execution, config),
          lastActivity: getLatestActivity(runtime)
        }
      }),
    [executionById, robots, runtimeById, simulatorConfig, simulatorConfigByRobotId]
  )

  const summary = useMemo(
    () =>
      fleet.reduce(
        (result, item) => {
          result[item.status] += 1
          return result
        },
        {
          running: 0,
          online: 0,
          ready: 0,
          connecting: 0,
          error: 0,
          offline: 0
        } satisfies Record<FleetStatus, number>
      ),
    [fleet]
  )

  const filteredFleet = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()

    return fleet.filter((item) => {
      const matchesStatus = statusFilter === 'all' || item.status === statusFilter
      const matchesSearch =
        !normalizedSearch ||
        item.robot.name.toLocaleLowerCase().includes(normalizedSearch) ||
        item.robot.model.toLocaleLowerCase().includes(normalizedSearch) ||
        item.robot.id.toLocaleLowerCase().includes(normalizedSearch)

      return matchesStatus && matchesSearch
    })
  }, [fleet, search, statusFilter])

  const detailRobot = fleet.find((item) => item.robot.id === detailRobotId) ?? null
  const deleteCandidate = fleet.find((item) => item.robot.id === deleteCandidateId) ?? null
  const onlineCount = summary.online + summary.running
  const attentionCount = summary.error + summary.offline
  const healthPercent =
    fleet.length === 0 ? 0 : Math.round(((onlineCount + summary.ready) / fleet.length) * 100)
  const runningItems = fleet.filter((item) => item.execution?.isPlaying)
  const activeIssues = fleet
    .filter((item) => item.runtime?.lastError || item.execution?.lastError)
    .slice(0, 5)
  const streamingCount = fleet.filter((item) => item.runtime?.lastTelemetryAt).length
  const freshTelemetryCount = fleet.filter(isTelemetryFresh).length
  const collisionAlertCount = fleet.filter((item) => item.runtime?.lastCollisionWarning).length
  const currentLatencies = fleet
    .map((item) => item.runtime?.lastTelemetryRoundTripMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const medianLatency = median(currentLatencies)
  const recentFleetLatencySamples = fleet
    .flatMap((item) => item.runtime?.telemetrySamples ?? [])
    .sort(
      (left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime()
    )
    .slice(-40)
    .map((sample) => sample.roundTripMs)

  const formatActivity = (value: string | null): string => {
    if (!value) return t('unknown')

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value

    return new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit'
    }).format(date)
  }

  const statusLabel = (status: FleetStatus): string => {
    const keys: Record<FleetStatus, TranslationKeys> = {
      running: 'running',
      online: 'online',
      ready: 'ready',
      connecting: 'connecting',
      error: 'error',
      offline: 'offline'
    }

    return t(keys[status])
  }

  const connectionMode = (config: BackendSimulatorConfig): string =>
    config.backendUrl.includes('localhost') || config.backendUrl.includes('127.0.0.1')
      ? t('localMode')
      : t('cloudMode')

  const formatLatency = (value?: number): string =>
    typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} ms` : t('unknown')

  const toggleSelected = (robotId: string): void => {
    setSelectedIds((current) =>
      current.includes(robotId)
        ? current.filter((selectedId) => selectedId !== robotId)
        : [...current, robotId]
    )
  }

  const handleConnectSelected = async (): Promise<void> => {
    const connectable = fleet.filter(
      (item) =>
        selectedIds.includes(item.robot.id) &&
        item.config.deviceSecret.trim() &&
        !item.runtime?.isConnected &&
        !item.runtime?.isRunning
    )

    if (connectable.length === 0) return

    setActionPending(true)
    try {
      await Promise.allSettled(connectable.map((item) => onConnectRobot(item.config)))
    } finally {
      setActionPending(false)
    }
  }

  const handleDisconnectSelected = (): void => {
    fleet
      .filter(
        (item) =>
          selectedIds.includes(item.robot.id) &&
          (item.runtime?.isConnected || item.runtime?.isRunning)
      )
      .forEach((item) => onDisconnectRobot(item.robot.id))
  }

  const allVisibleSelected =
    filteredFleet.length > 0 && filteredFleet.every((item) => selectedIds.includes(item.robot.id))
  const connectableSelected = fleet.some(
    (item) =>
      selectedIds.includes(item.robot.id) &&
      item.config.deviceSecret.trim() &&
      !item.runtime?.isConnected &&
      !item.runtime?.isRunning
  )
  const disconnectableSelected = fleet.some(
    (item) =>
      selectedIds.includes(item.robot.id) && (item.runtime?.isConnected || item.runtime?.isRunning)
  )
  const detailTelemetrySamples =
    detailRobot?.runtime?.telemetrySamples?.map((sample) => sample.roundTripMs) ?? []
  const detailTelemetryFresh = detailRobot ? isTelemetryFresh(detailRobot) : false
  const detailIoSnapshot = detailRobot?.runtime?.lastIoSnapshot
  const detailActiveCabinetOutputs = countActiveOutputs(detailIoSnapshot?.cabinetDigitalOutputs)
  const detailActiveToolOutputs = countActiveOutputs(detailIoSnapshot?.toolDigitalOutputs)
  const deleteCandidateIsActive = Boolean(
    deleteCandidate?.runtime?.isConnected ||
    deleteCandidate?.runtime?.isRunning ||
    deleteCandidate?.execution?.isPlaying
  )

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[#10131b]">
      <div className="mx-auto flex min-h-full w-full max-w-[1720px] flex-col gap-5 p-5 xl:p-6">
        <section className="relative overflow-hidden rounded-2xl border border-[#2a3040] bg-[linear-gradient(135deg,#191e2b_0%,#151925_55%,#131722_100%)] px-5 py-5 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
          <div className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-blue-500/10 blur-3xl" />
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-sky-300">
                <Gauge className="h-4 w-4" />
                {t('factorySummary')}
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-white">
                {t('dashboardTitle')}
              </h1>
              <p className="mt-1.5 max-w-3xl text-sm text-slate-400">{t('dashboardSubtitle')}</p>
            </div>

            <div
              className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold ${
                connectivity === 'online'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : connectivity === 'checking'
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                    : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
              }`}
              title={connectionError || undefined}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  connectivity === 'online'
                    ? 'bg-emerald-400'
                    : connectivity === 'checking'
                      ? 'animate-pulse bg-amber-400'
                      : 'bg-rose-400'
                }`}
              />
              {connectivity === 'online'
                ? t('liveData')
                : connectivity === 'checking'
                  ? t('checking')
                  : t('systemOffline')}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <MetricCard
            icon={Bot}
            label={t('total')}
            value={fleet.length}
            detail={t('fleetHealth')}
            tone="blue"
          />
          <MetricCard
            icon={CheckCircle2}
            label={t('online')}
            value={onlineCount}
            detail={`${healthPercent}% ${t('operational').toLocaleLowerCase()}`}
            tone="green"
          />
          <MetricCard
            icon={Play}
            label={t('runningRobots')}
            value={summary.running}
            detail={t('factoryRunMonitor')}
            tone="violet"
          />
          <MetricCard
            icon={Link2}
            label={t('configuredRobots')}
            value={summary.ready}
            detail={t('connectionKeyReady')}
            tone="amber"
          />
          <MetricCard
            icon={AlertTriangle}
            label={t('attentionNeeded')}
            value={attentionCount}
            detail={
              summary.error > 0
                ? `${summary.error} ${t('error').toLocaleLowerCase()}`
                : t('noActiveIssues')
            }
            tone="rose"
          />
        </section>

        <section className="grid gap-4 rounded-2xl border border-[#2a3040] bg-[#171b26] p-4 shadow-[0_14px_40px_rgba(0,0,0,0.16)] xl:grid-cols-[minmax(0,1.35fr)_minmax(440px,1fr)]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Activity className="h-4 w-4 text-sky-300" />
                  {t('liveMonitoring')}
                </h2>
                <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
                  {t('liveMonitoringSubtitle')}
                </p>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                  freshTelemetryCount > 0
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-slate-600 bg-slate-800 text-slate-400'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    freshTelemetryCount > 0 ? 'animate-pulse bg-emerald-400' : 'bg-slate-500'
                  }`}
                />
                {freshTelemetryCount > 0 ? t('liveData') : t('noLiveTelemetry')}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <LiveMetric
                icon={Activity}
                label={t('telemetryStreaming')}
                value={`${streamingCount}/${fleet.length}`}
              />
              <LiveMetric
                icon={Gauge}
                label={t('medianResponseTime')}
                value={medianLatency === null ? '—' : `${medianLatency.toFixed(1)} ms`}
                tone="emerald"
              />
              <LiveMetric
                icon={CheckCircle2}
                label={t('freshDataFeeds')}
                value={`${freshTelemetryCount}/${fleet.length}`}
                tone={freshTelemetryCount > 0 ? 'emerald' : 'amber'}
              />
              <LiveMetric
                icon={AlertTriangle}
                label={t('collisionAlerts')}
                value={String(collisionAlertCount)}
                tone={collisionAlertCount > 0 ? 'rose' : 'emerald'}
              />
            </div>
          </div>

          <div className="min-w-0 rounded-xl border border-[#252b39] bg-[#141925] p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-slate-300">{t('recentLatencyTrend')}</p>
              <span className="text-[10px] text-slate-600">
                {recentFleetLatencySamples.length} {t('recentSamples')}
              </span>
            </div>
            <TelemetrySparkline
              values={recentFleetLatencySamples}
              emptyLabel={t('connectForLiveData')}
            />
            <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
              {t('liveSessionOnly')}
            </p>
          </div>
        </section>

        <section className="grid min-h-[520px] flex-1 gap-5 xl:grid-cols-[minmax(0,1fr)_350px]">
          <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[#2a3040] bg-[#171b26]">
            <div className="border-b border-[#2a3040] px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-white">{t('fleetTitle')}</h2>
                  <p className="mt-1 text-xs text-slate-500">{t('fleetSubtitle')}</p>
                </div>

                {selectedIds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400">
                      {selectedIds.length} {t('selectedCount')}
                    </span>
                    <button
                      type="button"
                      disabled={!connectableSelected || actionPending || !accessToken}
                      onClick={() => void handleConnectSelected()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {actionPending ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Power className="h-3.5 w-3.5" />
                      )}
                      {t('connectSelected')}
                    </button>
                    <button
                      type="button"
                      disabled={!disconnectableSelected}
                      onClick={handleDisconnectSelected}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-rose-500/40 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Unplug className="h-3.5 w-3.5" />
                      {t('disconnectSelected')}
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <label className="relative min-w-[240px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('searchRobots')}
                    className="h-10 w-full rounded-xl border border-[#313748] bg-[#111520] pl-9 pr-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-500/50 focus:ring-2 focus:ring-sky-500/10"
                  />
                </label>

                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as FleetStatus | 'all')}
                  className="h-10 rounded-xl border border-[#313748] bg-[#111520] px-3 text-xs font-medium text-slate-200 outline-none focus:border-sky-500/50"
                >
                  <option value="all">{t('allStatuses')}</option>
                  {(['running', 'online', 'ready', 'connecting', 'error', 'offline'] as const).map(
                    (statusOption) => (
                      <option key={statusOption} value={statusOption}>
                        {statusLabel(statusOption)}
                      </option>
                    )
                  )}
                </select>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[860px] table-fixed text-left">
                <thead className="sticky top-0 z-10 bg-[#141925]/95 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 backdrop-blur">
                  <tr>
                    <th className="w-12 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={() =>
                          setSelectedIds((current) =>
                            allVisibleSelected
                              ? current.filter(
                                  (robotId) =>
                                    !filteredFleet.some((item) => item.robot.id === robotId)
                                )
                              : [
                                  ...new Set([
                                    ...current,
                                    ...filteredFleet.map((item) => item.robot.id)
                                  ])
                                ]
                          )
                        }
                        className="h-4 w-4 accent-sky-500"
                      />
                    </th>
                    <th className="w-[31%] px-2 py-3">{t('activeRobot')}</th>
                    <th className="w-[16%] px-2 py-3">{t('systemConnection')}</th>
                    <th className="w-[18%] px-2 py-3">{t('execution')}</th>
                    <th className="w-[18%] px-2 py-3">{t('lastActivity')}</th>
                    <th className="w-24 px-4 py-3 text-right">{t('actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#262c3a]">
                  {filteredFleet.map((item) => (
                    <tr
                      key={item.robot.id}
                      onClick={() => {
                        setDetailRobotId(item.robot.id)
                        setTechnicalDetailsOpen(false)
                      }}
                      className="group cursor-pointer transition hover:bg-sky-500/[0.04]"
                    >
                      <td className="px-4 py-3.5" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(item.robot.id)}
                          onChange={() => toggleSelected(item.robot.id)}
                          className="h-4 w-4 accent-sky-500"
                        />
                      </td>
                      <td className="px-2 py-3.5">
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-[#111520] ${STATUS_STYLES[item.status].border}`}
                          >
                            <Bot className="h-5 w-5 text-slate-300" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-100">
                              {item.robot.name}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-slate-500">
                              {item.robot.model}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-3.5">
                        <StatusBadge status={item.status} label={statusLabel(item.status)} />
                      </td>
                      <td className="px-2 py-3.5">
                        {item.execution?.isPlaying ? (
                          <div>
                            <p className="flex items-center gap-1.5 text-xs font-medium text-violet-200">
                              <Activity className="h-3.5 w-3.5" />
                              {t('programRunning')}
                            </p>
                            <p className="mt-1 text-[11px] text-slate-500">
                              {t('runningStep')} {item.execution.currentStepIndex + 1}
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500">{t('idle')}</span>
                        )}
                      </td>
                      <td className="px-2 py-3.5">
                        <p className="text-xs text-slate-400">
                          {formatActivity(item.lastActivity)}
                        </p>
                        {item.runtime?.lastTelemetryRoundTripMs !== undefined && (
                          <p
                            className={`mt-1 flex items-center gap-1.5 text-[10px] ${
                              isTelemetryFresh(item) ? 'text-emerald-300' : 'text-amber-300'
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                isTelemetryFresh(item) ? 'bg-emerald-400' : 'bg-amber-400'
                              }`}
                            />
                            {formatLatency(item.runtime.lastTelemetryRoundTripMs)} ·{' '}
                            {isTelemetryFresh(item) ? t('fresh') : t('delayed')}
                          </p>
                        )}
                      </td>
                      <td
                        className="px-4 py-3.5 text-right"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onOpenScene(item.robot.id)}
                            title={t('openIn3d')}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-slate-500 transition hover:border-sky-500/30 hover:bg-sky-500/10 hover:text-sky-300"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteError('')
                              setDeleteCandidateId(item.robot.id)
                            }}
                            disabled={Boolean(
                              item.runtime?.isConnected ||
                              item.runtime?.isRunning ||
                              item.execution?.isPlaying
                            )}
                            title={
                              item.runtime?.isConnected ||
                              item.runtime?.isRunning ||
                              item.execution?.isPlaying
                                ? t('deleteRobotBlocked')
                                : t('deleteRobot')
                            }
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-slate-500 transition hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filteredFleet.length === 0 && (
                <div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
                  <Search className="h-8 w-8 text-slate-700" />
                  <p className="mt-3 text-sm text-slate-400">{t('noMatchingRobots')}</p>
                </div>
              )}
            </div>
          </div>

          <aside className="flex min-h-0 flex-col gap-4">
            <div className="rounded-2xl border border-[#2a3040] bg-[#171b26] p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Server className="h-4 w-4 text-sky-300" />
                  {t('systemHealth')}
                </h2>
                <span className="text-xl font-semibold text-white">{healthPercent}%</span>
              </div>

              <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-400 transition-all"
                  style={{ width: `${healthPercent}%` }}
                />
              </div>

              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between rounded-xl bg-[#111520] px-3 py-2.5">
                  <span className="flex items-center gap-2 text-xs text-slate-400">
                    <Cloud className="h-4 w-4" />
                    {t('cloudConnection')}
                  </span>
                  <span
                    className={`text-xs font-semibold ${
                      connectivity === 'online' ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                  >
                    {connectivity === 'online' ? t('operational') : t('needsAttention')}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-xl bg-[#111520] px-3 py-2.5">
                  <span className="flex items-center gap-2 text-xs text-slate-400">
                    <Cpu className="h-4 w-4" />
                    {t('fleetHealth')}
                  </span>
                  <span className="text-xs font-semibold text-slate-200">
                    {onlineCount}/{fleet.length}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-xl bg-[#111520] px-3 py-2.5">
                  <span className="flex items-center gap-2 text-xs text-slate-400">
                    <Activity className="h-4 w-4" />
                    {t('factoryRunMonitor')}
                  </span>
                  <span className="text-xs font-semibold text-violet-200">
                    {runningItems.length} {t('running').toLocaleLowerCase()}
                  </span>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 rounded-2xl border border-[#2a3040] bg-[#171b26] p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                <AlertTriangle className="h-4 w-4 text-amber-300" />
                {t('recentIssues')}
              </h2>

              <div className="mt-4 space-y-2">
                {activeIssues.length === 0 ? (
                  <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-[#303747] bg-[#111520]/50 px-4 text-center">
                    <CheckCircle2 className="h-7 w-7 text-emerald-400" />
                    <p className="mt-2 text-xs font-medium text-slate-300">{t('noActiveIssues')}</p>
                  </div>
                ) : (
                  activeIssues.map((item) => (
                    <button
                      key={item.robot.id}
                      type="button"
                      onClick={() => setDetailRobotId(item.robot.id)}
                      className="flex w-full items-start gap-3 rounded-xl border border-rose-500/15 bg-rose-500/[0.06] p-3 text-left transition hover:border-rose-500/30"
                    >
                      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-rose-400" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-slate-200">
                          {item.robot.name}
                        </span>
                        <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-slate-500">
                          {item.execution?.lastError || item.runtime?.lastError}
                        </span>
                      </span>
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" />
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-[#2a3040] bg-[#171b26] p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                <Activity className="h-4 w-4 text-violet-300" />
                {t('factoryRunMonitor')}
              </h2>
              {runningItems.length === 0 ? (
                <p className="mt-3 text-xs text-slate-500">{t('noProgramsRunning')}</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {runningItems.slice(0, 3).map((item) => (
                    <div
                      key={item.robot.id}
                      className="flex items-center justify-between rounded-xl bg-[#111520] px-3 py-2.5"
                    >
                      <span className="truncate text-xs font-medium text-slate-300">
                        {item.robot.name}
                      </span>
                      <span className="ml-3 shrink-0 text-[11px] text-violet-300">
                        {t('runningStep')} {(item.execution?.currentStepIndex ?? 0) + 1}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </section>
      </div>

      {detailRobot && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-[2px]">
          <button
            type="button"
            aria-label={t('close')}
            className="min-w-0 flex-1 cursor-default"
            onClick={() => setDetailRobotId(null)}
          />
          <section className="flex h-full w-full max-w-[430px] flex-col border-l border-[#303747] bg-[#151923] shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-[#2a3040] p-5">
              <div className="min-w-0">
                <p className="text-xs font-medium text-sky-300">{t('robotDetails')}</p>
                <h2 className="mt-1 truncate text-xl font-semibold text-white">
                  {detailRobot.robot.name}
                </h2>
                <p className="mt-1 text-xs text-slate-500">{detailRobot.robot.model}</p>
              </div>
              <button
                type="button"
                onClick={() => setDetailRobotId(null)}
                className="rounded-lg border border-[#303747] p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
              <div className="rounded-2xl border border-[#2a3040] bg-[#111520] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-slate-400">
                    {t('operationSummary')}
                  </span>
                  <StatusBadge
                    status={detailRobot.status}
                    label={statusLabel(detailRobot.status)}
                  />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-[#191e2b] p-3">
                    <p className="text-[10px] uppercase tracking-wider text-slate-600">
                      {t('connectionSource')}
                    </p>
                    <p className="mt-1.5 text-xs font-semibold text-slate-200">
                      {connectionMode(detailRobot.config)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-[#191e2b] p-3">
                    <p className="text-[10px] uppercase tracking-wider text-slate-600">
                      {t('lastActivity')}
                    </p>
                    <p className="mt-1.5 text-xs font-semibold text-slate-200">
                      {formatActivity(detailRobot.lastActivity)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-[#191e2b] p-3">
                    <p className="text-[10px] uppercase tracking-wider text-slate-600">
                      {t('connectionType')}
                    </p>
                    <p className="mt-1.5 truncate text-xs font-semibold text-slate-200">
                      {detailRobot.robot.connectionType || t('unknown')}
                    </p>
                  </div>
                  <div className="rounded-xl bg-[#191e2b] p-3">
                    <p className="text-[10px] uppercase tracking-wider text-slate-600">
                      {t('connectionKey')}
                    </p>
                    <p
                      className={`mt-1.5 text-xs font-semibold ${
                        detailRobot.config.deviceSecret ? 'text-emerald-300' : 'text-amber-300'
                      }`}
                    >
                      {detailRobot.config.deviceSecret
                        ? t('connectionKeyReady')
                        : t('connectionKeyMissing')}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-sky-500/20 bg-sky-500/[0.04] p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="flex items-center gap-2 text-sm font-semibold text-sky-100">
                    <Activity className="h-4 w-4 text-sky-300" />
                    {t('liveTelemetry')}
                  </p>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold ${
                      detailTelemetryFresh
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                        : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        detailTelemetryFresh ? 'bg-emerald-400' : 'bg-amber-400'
                      }`}
                    />
                    {detailTelemetryFresh ? t('fresh') : t('delayed')}
                  </span>
                </div>

                {detailRobot.runtime?.lastTelemetryAt ? (
                  <>
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <div className="rounded-xl bg-[#111520] p-3">
                        <p className="text-[10px] uppercase tracking-wider text-slate-600">
                          {t('roundTripLatency')}
                        </p>
                        <p className="mt-1.5 text-sm font-semibold text-sky-200">
                          {formatLatency(detailRobot.runtime.lastTelemetryRoundTripMs)}
                        </p>
                      </div>
                      <div className="rounded-xl bg-[#111520] p-3">
                        <p className="text-[10px] uppercase tracking-wider text-slate-600">
                          {t('telemetrySequence')}
                        </p>
                        <p className="mt-1.5 text-sm font-semibold text-slate-200">
                          {detailRobot.runtime.lastTelemetrySequenceNumber ?? t('unknown')}
                        </p>
                      </div>
                      <div className="rounded-xl bg-[#111520] p-3">
                        <p className="text-[10px] uppercase tracking-wider text-slate-600">
                          {t('robotState')}
                        </p>
                        <p className="mt-1.5 text-sm font-semibold text-slate-200">
                          {detailRobot.runtime.lastTelemetryStatusCode ?? t('unknown')}
                        </p>
                      </div>
                      <div className="rounded-xl bg-[#111520] p-3">
                        <p className="text-[10px] uppercase tracking-wider text-slate-600">
                          {t('collisionStatus')}
                        </p>
                        <p
                          className={`mt-1.5 text-sm font-semibold ${
                            detailRobot.runtime.lastCollisionWarning
                              ? 'text-rose-300'
                              : 'text-emerald-300'
                          }`}
                        >
                          {detailRobot.runtime.lastCollisionWarning ? t('warning') : t('normal')}
                        </p>
                      </div>
                    </div>

                    <div className="mt-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-[10px] uppercase tracking-wider text-slate-600">
                          {t('recentLatencyTrend')}
                        </p>
                        <span className="text-[10px] text-slate-600">
                          {detailTelemetrySamples.length} {t('recentSamples')}
                        </span>
                      </div>
                      <TelemetrySparkline
                        values={detailTelemetrySamples}
                        emptyLabel={t('noLiveTelemetry')}
                      />
                    </div>

                    {detailRobot.runtime.lastExecutionSnapshot && (
                      <div className="mt-3 rounded-xl bg-[#111520] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[10px] uppercase tracking-wider text-slate-600">
                            {t('executionState')}
                          </p>
                          <span className="text-xs font-semibold text-violet-200">
                            {detailRobot.runtime.lastExecutionSnapshot.state === 'Running'
                              ? t('running')
                              : detailRobot.runtime.lastExecutionSnapshot.state === 'Failed'
                                ? t('error')
                                : t('idle')}
                          </span>
                        </div>
                        {detailRobot.runtime.lastExecutionSnapshot.progressPercent !==
                          undefined && (
                          <div className="mt-3">
                            <div className="mb-1.5 flex items-center justify-between text-[10px] text-slate-500">
                              <span>{t('programProgress')}</span>
                              <span>
                                {detailRobot.runtime.lastExecutionSnapshot.progressPercent.toFixed(
                                  0
                                )}
                                %
                              </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                              <div
                                className="h-full rounded-full bg-violet-400 transition-all"
                                style={{
                                  width: `${detailRobot.runtime.lastExecutionSnapshot.progressPercent}%`
                                }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {detailIoSnapshot && (
                      <div className="mt-3 rounded-xl bg-[#111520] p-3">
                        <p className="text-[10px] uppercase tracking-wider text-slate-600">
                          {t('ioStatus')}
                        </p>
                        <div className="mt-2 grid grid-cols-3 gap-2">
                          <div>
                            <p className="text-[10px] text-slate-600">{t('controllerOutputs')}</p>
                            <p className="mt-1 text-xs font-semibold text-slate-200">
                              {detailActiveCabinetOutputs} {t('activeOutputs').toLowerCase()}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-slate-600">{t('toolOutputs')}</p>
                            <p className="mt-1 text-xs font-semibold text-slate-200">
                              {detailActiveToolOutputs} {t('activeOutputs').toLowerCase()}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-slate-600">{t('gripper')}</p>
                            <p className="mt-1 text-xs font-semibold text-slate-200">
                              {detailIoSnapshot.gripperState === 'open' ? t('open') : t('closed')}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="mt-3 rounded-xl border border-dashed border-[#303747] bg-[#111520] p-4 text-xs leading-relaxed text-slate-500">
                    {t('connectForLiveData')}
                  </p>
                )}
              </div>

              {detailRobot.execution?.isPlaying && (
                <div className="rounded-2xl border border-violet-500/20 bg-violet-500/[0.06] p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-violet-200">
                    <Play className="h-4 w-4" />
                    {t('programRunning')}
                  </div>
                  <p className="mt-2 text-xs text-slate-400">
                    {t('runningStep')} {detailRobot.execution.currentStepIndex + 1}
                  </p>
                  {detailRobot.execution.startedAt && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      {t('startedAt')}: {formatActivity(detailRobot.execution.startedAt)}
                    </p>
                  )}
                </div>
              )}

              {(detailRobot.runtime?.lastError || detailRobot.execution?.lastError) && (
                <div className="rounded-2xl border border-rose-500/25 bg-rose-500/[0.07] p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-rose-200">
                    <AlertTriangle className="h-4 w-4" />
                    {t('needsAttention')}
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-rose-100/70">
                    {detailRobot.execution?.lastError || detailRobot.runtime?.lastError}
                  </p>
                </div>
              )}

              <RobotActivityHistory
                backendUrl={detailRobot.config.backendUrl}
                robotId={detailRobot.robot.id}
                token={accessToken}
                runtime={detailRobot.runtime}
              />

              <button
                type="button"
                onClick={() => setTechnicalDetailsOpen((current) => !current)}
                className="flex w-full items-center justify-between rounded-xl border border-[#303747] bg-[#111520] px-4 py-3 text-left text-xs font-semibold text-slate-300 transition hover:border-sky-500/30"
              >
                <span className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-slate-500" />
                  {technicalDetailsOpen ? t('hideTechnicalDetails') : t('showTechnicalDetails')}
                </span>
                <ChevronRight
                  className={`h-4 w-4 transition-transform ${
                    technicalDetailsOpen ? 'rotate-90' : ''
                  }`}
                />
              </button>

              {technicalDetailsOpen && (
                <div className="space-y-3 rounded-2xl border border-[#2a3040] bg-[#111520] p-4">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-slate-600">
                      {t('robotIdentifier')}
                    </p>
                    <code className="mt-1.5 block break-all text-[11px] text-slate-300">
                      {detailRobot.robot.id}
                    </code>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-slate-600">
                      {t('backendAddress')}
                    </p>
                    <code className="mt-1.5 block break-all text-[11px] text-slate-300">
                      {detailRobot.config.backendUrl || t('unknown')}
                    </code>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-slate-600">
                        {t('lastHeartbeat')}
                      </p>
                      <p className="mt-1.5 text-[11px] text-slate-300">
                        {formatActivity(detailRobot.runtime?.lastHeartbeatAt ?? null)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-slate-600">
                        {t('lastTelemetry')}
                      </p>
                      <p className="mt-1.5 text-[11px] text-slate-300">
                        {formatActivity(detailRobot.runtime?.lastTelemetryAt ?? null)}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-[#2a3040] p-5">
              {detailRobot.runtime?.isConnected || detailRobot.runtime?.isRunning ? (
                <button
                  type="button"
                  onClick={() => onDisconnectRobot(detailRobot.robot.id)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20"
                >
                  <Unplug className="h-4 w-4" />
                  {t('disconnect')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={
                    !accessToken || !detailRobot.config.deviceSecret.trim() || actionPending
                  }
                  onClick={async () => {
                    setActionPending(true)
                    try {
                      await onConnectRobot(detailRobot.config)
                    } finally {
                      setActionPending(false)
                    }
                  }}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {actionPending ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Power className="h-4 w-4" />
                  )}
                  {t('connect')}
                </button>
              )}
              <button
                type="button"
                onClick={() => onOpenScene(detailRobot.robot.id)}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 py-3 text-xs font-semibold text-white transition hover:bg-sky-400"
              >
                <Monitor className="h-4 w-4" />
                {t('openIn3d')}
              </button>
              <button
                type="button"
                disabled={
                  Boolean(
                    detailRobot.runtime?.isConnected ||
                    detailRobot.runtime?.isRunning ||
                    detailRobot.execution?.isPlaying
                  ) || deletePending
                }
                onClick={() => {
                  setDeleteError('')
                  setDeleteCandidateId(detailRobot.robot.id)
                }}
                title={
                  detailRobot.runtime?.isConnected ||
                  detailRobot.runtime?.isRunning ||
                  detailRobot.execution?.isPlaying
                    ? t('deleteRobotBlocked')
                    : t('deleteRobot')
                }
                className="col-span-2 inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.07] px-4 py-3 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
                {t('deleteRobot')}
              </button>
            </div>
          </section>
        </div>
      )}

      {deleteCandidate && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-robot-title"
            className="w-full max-w-md rounded-2xl border border-rose-500/25 bg-[#171b26] p-5 shadow-2xl"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300">
              <Trash2 className="h-5 w-5" />
            </div>
            <h2 id="delete-robot-title" className="mt-4 text-lg font-semibold text-white">
              {t('deleteRobotTitle')}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              {t('deleteRobotConfirm').replace('{name}', deleteCandidate.robot.name)}
            </p>
            <p className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5 text-xs leading-relaxed text-amber-200">
              {t('deleteRobotWarning')}
            </p>

            {deleteCandidateIsActive && (
              <p className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2.5 text-xs text-rose-200">
                {t('deleteRobotBlocked')}
              </p>
            )}

            {deleteError && (
              <p className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2.5 text-xs text-rose-200">
                {deleteError}
              </p>
            )}

            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={deletePending}
                onClick={() => {
                  setDeleteCandidateId(null)
                  setDeleteError('')
                }}
                className="rounded-xl border border-[#303747] px-4 py-3 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={deleteCandidateIsActive || deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  setDeleteError('')

                  try {
                    await onDeleteRobot(deleteCandidate.robot.id)
                    setSelectedIds((current) =>
                      current.filter((robotId) => robotId !== deleteCandidate.robot.id)
                    )
                    setDetailRobotId((current) =>
                      current === deleteCandidate.robot.id ? null : current
                    )
                    setDeleteCandidateId(null)
                  } catch (error) {
                    setDeleteError(error instanceof Error ? error.message : t('deleteRobotFailed'))
                  } finally {
                    setDeletePending(false)
                  }
                }}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-rose-500 px-4 py-3 text-xs font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deletePending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                {deletePending ? t('deletingRobot') : t('deleteRobot')}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
