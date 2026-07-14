import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  CloudUpload,
  Download,
  History,
  LoaderCircle,
  LogIn,
  LogOut,
  RefreshCw,
  X,
  Shield
} from 'lucide-react'
import { useRobotStore } from '../store/robotStore'
import CenterModal from './ui/CenterModal'
import { WorkflowStep } from '../types/robot.types'
import {
  BackendSimulatorConfig,
  defaultRobotRuntimeConfig,
  SafetyDiagnostic
} from '../types/backendDevice'
import { getRobotRuntimeConfig as fetchRobotRuntimeConfig } from '../services/backendRuntimeConfigClient'
import { setRobotRuntimeConfig } from '../services/robotMotionRuntime'
import { exportLuaProgramFromBackend } from '../services/backendLuaExportClient'
import { SafetyValidationError } from '../services/backendSafetyClient'
import SafetyDiagnosticsPanel from './SafetyDiagnosticsPanel'
import RobotSafetyPolicyPanel from './RobotSafetyPolicyPanel'
import TelemetryHistoryPanel from './TelemetryHistoryPanel'
import { getCachedDeviceRuntimeSessionId } from '../services/backendDeviceSession'
const CONFIG_KEY = 'syntwin.backendSimulator.config'
const TOKEN_KEY = 'syntwin.backendProgram.accessToken'
const EMAIL_KEY = 'syntwin.backendProgram.email'

interface ProgramResponse {
  id: string
}

interface CommandResultResponse {
  success: boolean
  message?: string | null
  rawPayload?: unknown
  completedAt: string
}

interface CommandFailureMetadata {
  source?: string
  stepIndex?: number
  stepOrderIndex?: number
  stepType?: string
  stepLabel?: string
  technicalMessage?: string
}

interface CommandResponse {
  id: string
  robotId: string
  commandType: string
  payload?: unknown
  status: string
  createdAt: string
  completedAt?: string | null
  failureReason?: string | null
  result?: CommandResultResponse | null
}
interface ProgramStepRequest {
  orderIndex: number
  stepType: string
  label: string
  payload: Record<string, unknown>
}

function getConfig(): BackendSimulatorConfig {
  const raw = localStorage.getItem(CONFIG_KEY)

  if (!raw) {
    throw new Error('Hãy cấu hình Backend Simulator trước')
  }

  const config = JSON.parse(raw) as BackendSimulatorConfig
  const selectedRobotId = useRobotStore.getState().selectedRobotId
  const activeRobotId = selectedRobotId?.trim() || config.robotId?.trim()

  if (!config.backendUrl?.trim()) {
    throw new Error('Backend URL đang trống')
  }

  if (!activeRobotId) {
    throw new Error('Robot ID đang trống')
  }

  return {
    ...config,
    robotId: activeRobotId
  }
}

function percent(value?: number): number {
  return Math.min(100, Math.max(1, value || 30))
}

function convertStep(step: WorkflowStep, index: number): ProgramStepRequest {
  const common = {
    orderIndex: index + 1,
    label: step.label || `${step.type} ${index + 1}`
  }

  switch (step.type) {
    case 'MoveJ':
      if (!step.jointAngles) {
        throw new Error(`${step.label}: missing jointAngles`)
      }

      return {
        ...common,
        stepType: 'MoveJ',
        payload: {
          jointAngles: step.jointAngles,
          speed: percent(step.speed),
          acc: percent(step.acc)
        }
      }

    case 'RotateJoint':
      if (
        !Number.isInteger(step.jointIndex) ||
        step.jointIndex === undefined ||
        step.jointIndex < 1 ||
        step.jointIndex > 6
      ) {
        throw new Error(`${step.label}: jointIndex must be between 1 and 6`)
      }

      if (step.angle === undefined || !Number.isFinite(step.angle)) {
        throw new Error(`${step.label}: missing angle`)
      }

      return {
        ...common,
        stepType: 'RotateJoint',
        payload: {
          // UI uses 1..6, Backend contract uses 0..5.
          jointIndex: step.jointIndex - 1,
          angle: step.angle,
          speed: percent(step.speed),
          acc: percent(step.acc)
        }
      }

    case 'MoveL':
      if (!step.tcpPose) {
        throw new Error(`${step.label}: missing tcpPose`)
      }

      return {
        ...common,
        stepType: 'MoveL',
        payload: {
          tcpPose: step.tcpPose,
          speed: percent(step.speed),
          acc: percent(step.acc)
        }
      }

    case 'MoveTCP':
      if (!step.tcpPose) {
        throw new Error(`${step.label}: MoveTCP must be resolved to an absolute tcpPose`)
      }

      return {
        ...common,
        stepType: 'MoveTCP',
        payload: {
          tcpPose: step.tcpPose,
          speed: percent(step.speed),
          acc: percent(step.acc)
        }
      }

    case 'SetDO':
      return {
        ...common,
        stepType: 'SetDO',
        payload: {
          doType: step.doType || 'cabinet',
          doIndex: step.doIndex ?? 1,
          doValue: step.doValue ?? 0
        }
      }

    case 'WaitMs':
      return {
        ...common,
        stepType: 'WaitMs',
        payload: {
          delayMs: Math.max(0, Math.round(step.delayMs || 0))
        }
      }

    case 'GripperOpen':
    case 'GripperClose':
      return {
        ...common,
        stepType: step.type,
        payload: {}
      }

    case 'Comment':
      return {
        ...common,
        stepType: 'Comment',
        payload: {
          text: step.comment || step.label
        }
      }
  }
}

async function api<T>(backendUrl: string, path: string, init: RequestInit): Promise<T> {
  const baseUrl = backendUrl.replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}${path}`, init)

  if (!response.ok) {
    const text = await response.text()

    let body: { message?: string; diagnostics?: SafetyDiagnostic[] } | null = null
    try {
      body = JSON.parse(text) as { message?: string; diagnostics?: SafetyDiagnostic[] }
    } catch {
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    // Safety validation 400 – throw typed error so caller can render diagnostics
    if (
      response.status === 400 &&
      Array.isArray(body?.diagnostics) &&
      (body?.diagnostics?.length ?? 0) > 0
    ) {
      throw new SafetyValidationError(
        body?.message ?? `HTTP 400`,
        body!.diagnostics as SafetyDiagnostic[]
      )
    }

    throw new Error(body?.message ?? `HTTP ${response.status}: ${text}`)
  }

  return response.json() as Promise<T>
}

function authHeaders(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  }
}

async function loadRuntimeConfigForProgram(
  config: BackendSimulatorConfig,
  token: string
): Promise<string | null> {
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
}

function formatCommandTime(value: string): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getCommandFailureMetadata(command?: CommandResponse): CommandFailureMetadata | null {
  const rawPayload = command?.result?.rawPayload

  if (!isRecord(rawPayload) || !isRecord(rawPayload.failure)) {
    return null
  }

  return rawPayload.failure as CommandFailureMetadata
}

function getCommandFailureMessage(command?: CommandResponse): string {
  if (!command) {
    return 'Xem lỗi trong Backend Simulator.'
  }

  const metadata = getCommandFailureMetadata(command)
  const resultMessage = command.result?.message?.trim()
  const failureReason = command.failureReason?.trim()
  const technicalMessage = metadata?.technicalMessage?.trim()
  const message = resultMessage || failureReason || technicalMessage

  if (!message) {
    return 'Xem lỗi trong Backend Simulator.'
  }

  if (metadata?.stepIndex || metadata?.stepType || metadata?.stepLabel) {
    const stepPrefix = [
      metadata.stepIndex ? `Step ${metadata.stepIndex}` : '',
      metadata.stepType || '',
      metadata.stepLabel ? `- ${metadata.stepLabel}` : ''
    ]
      .filter(Boolean)
      .join(' ')

    return stepPrefix ? `${stepPrefix}: ${message}` : message
  }

  return message
}

function commandStatusClass(status: string): string {
  switch (status) {
    case 'Completed':
      return 'bg-emerald-950/40 text-emerald-300'

    case 'Pending':
      return 'bg-amber-950/40 text-amber-300'

    case 'Sent':
      return 'bg-blue-950/40 text-blue-300'

    case 'Failed':
    case 'Timeout':
    case 'Cancelled':
      return 'bg-red-950/40 text-red-300'

    default:
      return 'bg-slate-800 text-slate-300'
  }
}

// ─── DetailRow ──────────────────────────────────────────────────────────────

function DetailRow({
  label,
  value,
  danger
}: {
  label: string
  value?: string | number | null
  danger?: boolean
}): React.ReactElement | null {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className="flex gap-2 py-0.5">
      <span className="shrink-0 w-28 text-[9px] text-slate-500 font-medium">{label}</span>
      <span
        className={`text-[10px] break-all leading-snug ${danger ? 'text-red-300' : 'text-slate-200'}`}
        title={String(value)}
      >
        {String(value)}
      </span>
    </div>
  )
}

// ─── CommandDetailPopover ───────────────────────────────────────────────────

interface CommandDetailPopoverProps {
  command: CommandResponse
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}

function CommandDetailPopover({
  command,
  anchorRef,
  onClose
}: CommandDetailPopoverProps): React.ReactElement | null {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return

    const rect = anchor.getBoundingClientRect()
    const popoverWidth = 300
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let left = rect.right + 6
    if (left + popoverWidth > viewportWidth - 8) {
      left = rect.left - popoverWidth - 6
    }
    if (left < 8) left = 8

    let top = rect.top
    const estimatedHeight = 260
    if (top + estimatedHeight > viewportHeight - 8) {
      top = Math.max(8, viewportHeight - estimatedHeight - 8)
    }

    setPosition({ top, left })
  }, [anchorRef])

  // Close on outside click
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(event.target as Node)
      ) {
        onClose()
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [anchorRef, onClose])

  if (!position) return null

  const metadata = getCommandFailureMetadata(command)
  const isFailed =
    command.status === 'Failed' || command.status === 'Timeout' || command.status === 'Cancelled'

  const resultMessage = command.result?.message?.trim()
  const failureReason = command.failureReason?.trim()

  return (
    <div
      ref={popoverRef}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: 300,
        zIndex: 9999
      }}
      className="rounded-lg border border-[#393942] bg-[#101014] shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#2d2d34] px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-bold shrink-0 ${commandStatusClass(command.status)}`}
          >
            {command.status}
          </span>
          <span className="text-[10px] font-semibold text-slate-200 truncate">
            {command.commandType}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Đóng"
          className="ml-2 shrink-0 rounded p-0.5 text-slate-500 hover:bg-[#25252b] hover:text-slate-200 transition"
        >
          <X size={12} />
        </button>
      </div>

      {/* Body */}
      <div className="px-3 py-2 space-y-0.5">
        <DetailRow label="Command ID" value={command.id} />
        <DetailRow label="Command Type" value={command.commandType} />
        <DetailRow label="Status" value={command.status} />
        <DetailRow
          label="Created At"
          value={command.createdAt ? formatCommandTime(command.createdAt) : undefined}
        />
        {command.completedAt && (
          <DetailRow label="Completed At" value={formatCommandTime(command.completedAt)} />
        )}

        {isFailed && (
          <>
            <div className="my-1.5 border-t border-[#2d2d34]" />
            <p className="text-[9px] font-bold uppercase text-red-400 mb-1">Failure Detail</p>
            {resultMessage && <DetailRow label="Result Message" value={resultMessage} danger />}
            {failureReason && <DetailRow label="Failure Reason" value={failureReason} danger />}

            {metadata && (
              <>
                {metadata.stepIndex !== undefined && (
                  <DetailRow label="Step Index" value={metadata.stepIndex} />
                )}
                {metadata.stepOrderIndex !== undefined && (
                  <DetailRow label="Step Order Index" value={metadata.stepOrderIndex} />
                )}
                {metadata.stepType && <DetailRow label="Step Type" value={metadata.stepType} />}
                {metadata.stepLabel && <DetailRow label="Step Label" value={metadata.stepLabel} />}
                {metadata.technicalMessage && (
                  <DetailRow label="Technical Msg" value={metadata.technicalMessage} danger />
                )}
                {metadata.source && <DetailRow label="Source" value={metadata.source} />}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function BackendProgramControls(): React.ReactElement {
  const steps = useRobotStore((state) => state.steps)
  const projectName = useRobotStore((state) => state.projectName)
  const programSource = useRobotStore((state) => state.programSource)
  const setSelectedStepId = useRobotStore((state) => state.setSelectedStepId)
  const robots = useRobotStore((state) => state.robots)
  const selectedRobotId = useRobotStore((state) => state.selectedRobotId)

  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_KEY) || '')

  const [password, setPassword] = useState('')

  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '')

  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)

  // Safety diagnostics state for publish / RunProgram failures
  const [safetyDiagnostics, setSafetyDiagnostics] = useState<{
    message: string
    diagnostics: SafetyDiagnostic[]
  } | null>(null)

  const [commandHistory, setCommandHistory] = useState<CommandResponse[]>([])
  const [lastProgramId, setLastProgramId] = useState('')

  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false)
  const [isSafetyModalOpen, setIsSafetyModalOpen] = useState(false)
  const [isTelemetryModalOpen, setIsTelemetryModalOpen] = useState(false)

  // ── Detail Popover state ──────────────────────────────────────────────────
  const [selectedCommandDetailId, setSelectedCommandDetailId] = useState<string | null>(null)
  // Map of command id → button ref
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const anchorRef = useRef<HTMLButtonElement | null>(null)

  const activeRobot = robots.find((robot) => robot.id === selectedRobotId) ?? null
  const activeRobotTitle = activeRobot?.name ?? 'No robot selected'
  const activeRobotSubtitle = activeRobot
    ? activeRobot.model
    : selectedRobotId
      ? selectedRobotId
      : 'Select a robot before running backend commands'

  const selectedCommand = selectedCommandDetailId
    ? (commandHistory.find((c) => c.id === selectedCommandDetailId) ?? null)
    : null

  const handleToggleDetail = (commandId: string, button: HTMLButtonElement): void => {
    if (selectedCommandDetailId === commandId) {
      setSelectedCommandDetailId(null)
      anchorRef.current = null
    } else {
      anchorRef.current = button
      setSelectedCommandDetailId(commandId)
    }
  }

  const loadCommandHistory = useCallback(
    async (showLoading = false): Promise<void> => {
      if (!token) {
        setCommandHistory([])
        return
      }

      if (showLoading) {
        setHistoryLoading(true)
      }

      try {
        const config = getConfig()

        const commands = await api<CommandResponse[]>(
          config.backendUrl,
          `/api/robots/${config.robotId}/commands`,
          {
            method: 'GET',
            headers: authHeaders(token)
          }
        )

        setCommandHistory(commands.slice(0, 10))
        setHistoryError('')
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : 'Failed to load command history.')
      } finally {
        if (showLoading) {
          setHistoryLoading(false)
        }
      }
    },
    [token, selectedRobotId]
  )

  useEffect(() => {
    if (!token || busy) {
      return
    }

    const initialTimeoutId = window.setTimeout(() => {
      void loadCommandHistory(false)
    }, 0)

    const intervalId = window.setInterval(() => {
      void loadCommandHistory(false)
    }, 3000)

    return () => {
      window.clearTimeout(initialTimeoutId)
      window.clearInterval(intervalId)
    }
  }, [token, busy, loadCommandHistory])

  useEffect(() => {
    setCommandHistory([])
    setHistoryError('')
    setLastProgramId('')
    setSafetyDiagnostics(null)
    setIsTelemetryModalOpen(false)
    setSelectedCommandDetailId(null)
    anchorRef.current = null
  }, [selectedRobotId])

  const handleLogin = async (): Promise<void> => {
    setBusy(true)
    setFailed(false)
    setMessage('Đang đăng nhập...')

    try {
      const config = getConfig()

      const result = await api<{ accessToken: string }>(config.backendUrl, '/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: email.trim(),
          password
        })
      })

      localStorage.setItem(EMAIL_KEY, email.trim())
      sessionStorage.setItem(TOKEN_KEY, result.accessToken)

      setToken(result.accessToken)
      setPassword('')
      setMessage('Đăng nhập thành công')
    } catch (error) {
      setFailed(true)
      setMessage(error instanceof Error ? error.message : 'Đăng nhập thất bại')
    } finally {
      setBusy(false)
    }
  }

  const handleExportBackendLua = async (): Promise<void> => {
    if (!token) {
      setFailed(true)
      setMessage('Hãy đăng nhập trước')
      return
    }

    if (!lastProgramId) {
      setFailed(true)
      setMessage('Chưa có Backend Program để export')
      return
    }

    setBusy(true)
    setFailed(false)
    setMessage('Đang export LUA từ Backend...')

    try {
      const config = getConfig()

      const exported = await exportLuaProgramFromBackend(
        config.backendUrl,
        config.robotId,
        lastProgramId,
        token
      )

      const blob = new Blob([exported.luaContent], {
        type: 'text/x-lua;charset=utf-8'
      })

      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = exported.fileName || 'robot_program.lua'
      link.click()
      URL.revokeObjectURL(url)

      setMessage(`Đã export ${exported.fileName}`)
    } catch (error) {
      setFailed(true)
      setMessage(error instanceof Error ? error.message : 'Export LUA thất bại')
    } finally {
      setBusy(false)
    }
  }

  const handleSaveAndRun = async (): Promise<void> => {
    if (!token) {
      setFailed(true)
      setMessage('Hãy đăng nhập trước')
      return
    }

    if (steps.length === 0) {
      setFailed(true)
      setMessage('Workflow chưa có step')
      return
    }

    setBusy(true)
    setFailed(false)
    setSafetyDiagnostics(null)

    try {
      const config = getConfig()
      const name = (projectName.trim() || 'fairino_ui_program').slice(0, 100)
      setMessage('Đang tải Runtime Config...')

      const runtimeConfigWarning = await loadRuntimeConfigForProgram(config, token)

      if (runtimeConfigWarning) {
        console.warn(`Runtime config fallback: ${runtimeConfigWarning}`)
      }

      setMessage('Đang tạo Program...')

      const program = await api<ProgramResponse>(
        config.backendUrl,
        `/api/robots/${config.robotId}/programs`,
        {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({
            name,
            status: 'Draft',
            source: programSource,
            steps: steps.map(convertStep)
          })
        }
      )
      setLastProgramId(program.id)

      setMessage('Đang Publish...')

      try {
        await api<ProgramResponse>(
          config.backendUrl,
          `/api/robots/${config.robotId}/programs/${program.id}/publish`,
          {
            method: 'POST',
            headers: authHeaders(token)
          }
        )
      } catch (publishErr) {
        if (publishErr instanceof SafetyValidationError) {
          setSafetyDiagnostics({ message: publishErr.message, diagnostics: publishErr.diagnostics })
          setMessage('')
          setFailed(false)
          // Highlight first step with a stepOrderIndex if available
          const firstStepDiag = publishErr.diagnostics.find((d) => d.stepOrderIndex !== null)
          if (firstStepDiag?.stepOrderIndex != null) {
            const stepIdx = firstStepDiag.stepOrderIndex - 1
            const matchingStep = steps[stepIdx]
            if (matchingStep) setSelectedStepId(matchingStep.id)
          }
          return
        }
        throw publishErr
      }

      setMessage('Đang gửi RunProgram...')

      let command: CommandResponse
      try {
        command = await api<CommandResponse>(
          config.backendUrl,
          `/api/robots/${config.robotId}/commands`,
          {
            method: 'POST',
            headers: authHeaders(token),
            body: JSON.stringify({
              commandType: 'RunProgram',
              payload: {
                programId: program.id
              }
            })
          }
        )
      } catch (runErr) {
        if (runErr instanceof SafetyValidationError) {
          setSafetyDiagnostics({ message: runErr.message, diagnostics: runErr.diagnostics })
          setMessage('')
          setFailed(false)
          const firstStepDiag = runErr.diagnostics.find((d) => d.stepOrderIndex !== null)
          if (firstStepDiag?.stepOrderIndex != null) {
            const stepIdx = firstStepDiag.stepOrderIndex - 1
            const matchingStep = steps[stepIdx]
            if (matchingStep) setSelectedStepId(matchingStep.id)
          }
          return
        }
        throw runErr
      }

      setCommandHistory((current) =>
        [command, ...current.filter((item) => item.id !== command.id)].slice(0, 10)
      )

      let latestCommand: CommandResponse = command
      let status = latestCommand.status
      setMessage(`RunProgram: ${status}`)

      for (let attempt = 0; attempt < 300; attempt++) {
        if (
          status === 'Completed' ||
          status === 'Failed' ||
          status === 'Timeout' ||
          status === 'Cancelled'
        ) {
          break
        }

        await wait(1000)

        const commands = await api<CommandResponse[]>(
          config.backendUrl,
          `/api/robots/${config.robotId}/commands`,
          {
            method: 'GET',
            headers: authHeaders(token)
          }
        )

        setCommandHistory(commands.slice(0, 10))
        setHistoryError('')

        latestCommand = commands.find((item) => item.id === command.id) || latestCommand
        status = latestCommand.status || 'Unknown'

        setMessage(`RunProgram: ${status}`)
      }

      if (status !== 'Completed') {
        const failureMessage = getCommandFailureMessage(latestCommand)
        throw new Error(`RunProgram ${status}: ${failureMessage}`)
      }

      setMessage('RunProgram: Completed')
    } catch (error) {
      setFailed(true)
      setMessage(error instanceof Error ? error.message : 'Save and Run thất bại')
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = (): void => {
    sessionStorage.removeItem(TOKEN_KEY)
    setToken('')
    setPassword('')
    setMessage('')
    setFailed(false)
    setSafetyDiagnostics(null)
    setIsTelemetryModalOpen(false)
    setCommandHistory([])
    setHistoryError('')
    setSelectedCommandDetailId(null)
    anchorRef.current = null
  }

  return (
    <div className="shrink-0 border-b border-[#2d2d34] bg-[#18181c] p-3 text-slate-200">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase text-slate-400">Backend Program</span>

        <span className={token ? 'text-[10px] text-emerald-400' : 'text-[10px] text-slate-500'}>
          {token ? 'Đã đăng nhập' : 'Chưa đăng nhập'}
        </span>
      </div>

      <div className="mb-3 rounded border border-[#343849] bg-[#10131b] px-3 py-2">
        <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">
          Active Robot
        </div>
        <div className="mt-1 truncate text-xs font-semibold text-white">{activeRobotTitle}</div>
        <div className="mt-0.5 truncate text-[10px] text-slate-400">{activeRobotSubtitle}</div>
      </div>

      {!token ? (
        <div className="grid grid-cols-2 gap-2">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
            className="min-w-0 rounded border border-[#393942] bg-[#0f0f12] px-2 py-1.5 text-[11px] text-white outline-none"
          />

          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleLogin()
              }
            }}
            placeholder="Mật khẩu"
            className="min-w-0 rounded border border-[#393942] bg-[#0f0f12] px-2 py-1.5 text-[11px] text-white outline-none"
          />

          <button
            onClick={() => void handleLogin()}
            disabled={busy || !email.trim() || !password}
            className="col-span-2 flex items-center justify-center gap-1.5 rounded bg-blue-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            {busy ? <LoaderCircle size={12} className="animate-spin" /> : <LogIn size={12} />}
            Đăng nhập Backend
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => void handleSaveAndRun()}
            disabled={busy || steps.length === 0}
            className="flex flex-1 items-center justify-center gap-1.5 rounded bg-blue-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-blue-500 disabled:opacity-40"
          >
            {busy ? <LoaderCircle size={13} className="animate-spin" /> : <CloudUpload size={13} />}
            Lưu, Publish và Chạy
          </button>

          <button
            onClick={() => void handleExportBackendLua()}
            disabled={busy || !lastProgramId}
            title="Export LUA từ Backend"
            className="rounded border border-[#393942] px-2 text-slate-400 hover:border-blue-500 hover:text-white disabled:opacity-40"
          >
            <Download size={13} />
          </button>

          <button
            onClick={handleLogout}
            disabled={busy}
            title="Đăng xuất"
            className="rounded border border-[#393942] px-2 text-slate-400"
          >
            <LogOut size={13} />
          </button>
        </div>
      )}

      {/* Safety diagnostics panel (publish / RunProgram 400 response) */}
      {safetyDiagnostics && (
        <div className="mt-2">
          <SafetyDiagnosticsPanel
            message={safetyDiagnostics.message}
            diagnostics={safetyDiagnostics.diagnostics}
            onClose={() => setSafetyDiagnostics(null)}
          />
        </div>
      )}

      {message && (
        <div
          className={`mt-2 rounded border px-2 py-1.5 text-[10px] ${
            failed
              ? 'border-red-500/40 bg-red-950/30 text-red-200'
              : 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200'
          }`}
        >
          {message}
        </div>
      )}

      {/* Safety Policy & Command History Buttons */}
      {token && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setIsSafetyModalOpen(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded border border-[#343849] bg-[#242833] py-2 text-[10px] font-bold uppercase tracking-wider text-slate-300 transition hover:bg-[#2d313f] hover:text-white"
          >
            <Shield size={12} className="text-blue-400" />
            Safety Policy
          </button>

          <button
            type="button"
            onClick={() => setIsHistoryModalOpen(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded border border-[#343849] bg-[#242833] py-2 text-[10px] font-bold uppercase tracking-wider text-slate-300 transition hover:bg-[#2d313f] hover:text-white"
          >
            <History size={12} className="text-blue-400" />
            History ({commandHistory.length})
          </button>

          <button
            type="button"
            onClick={() => setIsTelemetryModalOpen(true)}
            className="flex items-center justify-center gap-1.5 rounded border border-[#343849] bg-[#242833] py-2 text-[10px] font-bold uppercase tracking-wider text-slate-300 transition hover:bg-[#2d313f] hover:text-white"
          >
            <Activity size={12} className="text-blue-400" />
            Telemetry
          </button>
        </div>
      )}

      {/* Safety Policy Modal */}
      {token &&
        (() => {
          let cfg: BackendSimulatorConfig | null = null
          try {
            cfg = getConfig()
          } catch {
            /* not configured yet */
          }

          return cfg ? (
            <CenterModal
              title="Robot Safety Policy"
              subtitle={`Robot ID: ${cfg.robotId}`}
              icon={<Shield size={16} />}
              open={isSafetyModalOpen}
              onClose={() => setIsSafetyModalOpen(false)}
              size="lg"
            >
              <RobotSafetyPolicyPanel
                backendUrl={cfg.backendUrl}
                robotId={cfg.robotId}
                token={token}
                embed={true}
              />
            </CenterModal>
          ) : null
        })()}

      {/* Telemetry History Modal */}
      {token &&
        (() => {
          let cfg: BackendSimulatorConfig | null = null
          try {
            cfg = getConfig()
          } catch {
            /* not configured yet */
          }

          return cfg ? (
            <CenterModal
              title="Telemetry History"
              subtitle={`Robot ID: ${cfg.robotId}`}
              icon={<Activity size={16} />}
              open={isTelemetryModalOpen}
              onClose={() => setIsTelemetryModalOpen(false)}
              size="xl"
            >
              <TelemetryHistoryPanel
                backendUrl={cfg.backendUrl}
                robotId={cfg.robotId}
                token={token}
                runtimeSessionId={getCachedDeviceRuntimeSessionId(cfg)}
              />
            </CenterModal>
          ) : null
        })()}

      {/* Command History Modal */}
      {token && (
        <CenterModal
          title="Command History"
          subtitle="Các lệnh đã gửi tới Robot từ Backend"
          icon={<History size={16} />}
          open={isHistoryModalOpen}
          onClose={() => {
            setIsHistoryModalOpen(false)
            setSelectedCommandDetailId(null)
            anchorRef.current = null
          }}
          size="lg"
        >
          <div className="flex flex-col h-[60vh] text-slate-200">
            <div className="flex justify-between items-center mb-3">
              <span className="text-xs text-slate-400">Hiển thị 10 command gần nhất</span>
              <button
                type="button"
                disabled={historyLoading || busy}
                onClick={() => void loadCommandHistory(true)}
                className="flex items-center gap-1 px-3 py-1 rounded border border-[#343849] bg-[#242833] text-xs text-slate-300 hover:bg-[#2d313f] hover:text-white transition disabled:opacity-40"
              >
                <RefreshCw size={12} className={historyLoading ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>

            {historyError && (
              <p className="mb-3 rounded border border-red-500/30 bg-red-950/20 px-3 py-2 text-xs text-red-300">
                {historyError}
              </p>
            )}

            <div className="flex-1 overflow-y-auto border border-[#343849] rounded-lg bg-[#0c0e16]">
              {commandHistory.length === 0 ? (
                <p className="p-8 text-center text-xs text-slate-500">
                  Chưa có lịch sử lệnh nào được thực thi.
                </p>
              ) : (
                commandHistory.map((command) => {
                  const failureMessage =
                    command.status === 'Failed' ||
                    command.status === 'Timeout' ||
                    command.status === 'Cancelled'
                      ? getCommandFailureMessage(command)
                      : ''

                  const isDetailOpen = selectedCommandDetailId === command.id

                  return (
                    <div key={command.id} className="border-b border-[#242833] p-4 last:border-b-0">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-white">
                              {command.commandType}
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${commandStatusClass(command.status)}`}
                            >
                              {command.status}
                            </span>
                          </div>
                          <p className="mt-1 font-mono text-[10px] text-slate-500">
                            ID: {command.id}
                          </p>
                          <p className="mt-1 text-[10px] text-slate-400">
                            Thời gian tạo: {new Date(command.createdAt).toLocaleString()}
                          </p>
                          {failureMessage && (
                            <div className="mt-2 rounded border border-red-500/35 bg-red-950/40 p-2 text-[10px] text-red-300">
                              <span className="font-semibold block mb-0.5">Failure Detail:</span>
                              {failureMessage}
                            </div>
                          )}
                        </div>

                        <button
                          type="button"
                          ref={(el) => {
                            if (el) {
                              buttonRefs.current.set(command.id, el)
                            } else {
                              buttonRefs.current.delete(command.id)
                            }
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            const btn = buttonRefs.current.get(command.id)
                            if (btn) handleToggleDetail(command.id, btn)
                          }}
                          className={`rounded px-2 py-1 text-xs font-semibold transition ${
                            isDetailOpen
                              ? 'bg-blue-600 text-white'
                              : 'border border-[#343849] bg-[#242833] text-slate-300 hover:text-white'
                          }`}
                        >
                          {isDetailOpen ? 'Ẩn chi tiết' : 'Chi tiết'}
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </CenterModal>
      )}

      {/* Floating detail popover – rendered at fixed position */}
      {selectedCommand && (
        <CommandDetailPopover
          command={selectedCommand}
          anchorRef={anchorRef as React.RefObject<HTMLElement | null>}
          onClose={() => {
            setSelectedCommandDetailId(null)
            anchorRef.current = null
          }}
        />
      )}
    </div>
  )
}
