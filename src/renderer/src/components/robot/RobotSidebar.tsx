import {
  AlertTriangle,
  Cpu,
  FileCode2,
  HelpCircle,
  Home,
  KeyRound,
  Move3D,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  Server,
  Square,
  Trash2,
  ChevronsLeft,
  ChevronsRight
} from 'lucide-react'
import { backendFetch } from '../../services/backendFetch'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactElement } from 'react'
import {
  waitForRobotCommand,
  type BackendCommandResponse,
  type BackendProgramContext
} from '../../services/backendProgramClient'
import FactoryLuaProgramModal from '../factory/FactoryLuaProgramModal'
import { useFactoryProgramStore } from '../../store/factoryProgramStore'
import { translations } from '../../i18n/translations'
import { useRobotStore } from '../../store/robotStore'
import { useSceneStore } from '../../store/sceneStore'
import {
  buildRobotCollisionPresentation,
  isTechnicalCollisionError
} from '../../services/collision/collisionPresentation'
import {
  DEFAULT_JOINT_ANGLES,
  type JointAngles,
  type RobotInstance,
  type RobotSceneBinding
} from '../../types/robot.types'
import {
  cancelActiveCommand,
  cancelAllActiveCommands
} from '../../services/commandExecutionRuntime'
import { buildCommandFailurePresentation } from '../../services/commandFailurePresentation'
import {
  recoverAllRobotCommandFaults,
  recoverRobotCommandFault
} from '../../services/robotFaultRuntime'
import ScenePanel from '../scene/ScenePanel'
import BackendSimulatorPanel from '../BackendSimulatorPanel'
import AddRobotWizard from './AddRobotWizard'
import {
  BackendRobotClientError,
  deleteRobot,
  listCompanies,
  listRobots,
  updateRobotSceneBinding as updateBackendRobotSceneBinding,
  type BackendCompany,
  type BackendRobot
} from '../../services/backendRobotClient'
import { checkBackendHealth } from '../../services/backendHealthClient'
import { useBackendAuthStore } from '../../store/backendAuthStore'
import {
  BackendSimulatorConfig,
  BackendSimulatorConfigByRobotId,
  BackendSimulatorStatus
} from '../../types/backendDevice'

const FACTORY_SIDEBAR_TCP_POSE = Object.freeze({
  x: 0,
  y: 0,
  z: 0,
  rx: 0,
  ry: 0,
  rz: 0
})

interface InfoTooltipProps {
  text: string
}

interface SceneBindingSaveFeedback {
  status: 'saving' | 'success' | 'error'
  message: string
}

interface CommandRecoveryFeedback {
  status: 'working' | 'success' | 'error'
  message: string
}

function InfoTooltip({ text }: InfoTooltipProps): ReactElement {
  return (
    <div
      className="group relative inline-block shrink-0 select-none align-middle"
      onClick={(event) => event.stopPropagation()}
    >
      <HelpCircle
        size={11}
        className="cursor-help text-slate-400 transition hover:text-slate-200"
      />
      <div className="pointer-events-none absolute bottom-full left-1/2 z-[100] mb-2 hidden w-56 -translate-x-1/2 rounded-lg border border-[#2d2d34] bg-[#121214]/95 p-2.5 text-[10px] font-normal leading-relaxed text-slate-300 shadow-2xl backdrop-blur-md normal-case group-hover:block">
        {text}
        <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-[#121214]" />
      </div>
    </div>
  )
}

function formatRuntimeTime(value?: string): string {
  if (!value) return '-'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return '-'

  return date.toLocaleTimeString()
}

function getRobotRuntimeBadge(status?: BackendSimulatorStatus): {
  label: string
  color: string
  dot: string
} {
  if (status?.lastError && !status.isConnected) {
    return {
      label: 'ERROR',
      color: 'border border-red-500/40 bg-red-950/35 text-red-300',
      dot: 'bg-red-400'
    }
  }

  if (status?.isConnected) {
    return {
      label: 'ONLINE',
      color: 'border border-emerald-500/40 bg-emerald-950/30 text-emerald-300',
      dot: 'bg-emerald-400'
    }
  }

  if (status?.isRunning) {
    return {
      label: 'CONNECTING',
      color: 'border border-amber-500/40 bg-amber-950/30 text-amber-300',
      dot: 'bg-amber-400'
    }
  }

  return {
    label: 'OFFLINE',
    color: 'border border-slate-500/30 bg-slate-500/10 text-slate-400',
    dot: 'bg-slate-400'
  }
}

const JOINT_BOUNDS = [
  { min: -175, max: 175 },
  { min: -265, max: 85 },
  { min: -160, max: 160 },
  { min: -265, max: 85 },
  { min: -175, max: 175 },
  { min: -175, max: 175 }
]

const ADD_ROBOT_COMPANY_KEY = 'syntwin.addRobot.companyId'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2
}

function toRobotSceneBinding(robot: BackendRobot): RobotSceneBinding {
  return {
    id: robot.sceneBinding?.id,
    sceneType: robot.sceneBinding?.sceneType || 'FairinoStudio',
    baseX: robot.sceneBinding?.baseX ?? 0,
    baseY: robot.sceneBinding?.baseY ?? 0,
    baseZ: robot.sceneBinding?.baseZ ?? 0,
    baseYaw: robot.sceneBinding?.baseYaw ?? 0,
    urdfPath: robot.sceneBinding?.urdfPath ?? null,
    primPath: robot.sceneBinding?.primPath ?? null,
    rosNamespace: robot.sceneBinding?.rosNamespace ?? null,
    graphPath: robot.sceneBinding?.graphPath ?? null
  }
}

function toRobotInstance(robot: BackendRobot): RobotInstance {
  return {
    id: robot.id,
    name: robot.robotName,
    model: robot.model,
    status: robot.status,
    connectionType: robot.connectionType,
    robotModelId: robot.robotModelId,
    sceneBinding: robot.sceneBinding
      ? {
          id: robot.sceneBinding.id,
          sceneType: robot.sceneBinding.sceneType,
          baseX: robot.sceneBinding.baseX,
          baseY: robot.sceneBinding.baseY,
          baseZ: robot.sceneBinding.baseZ,
          baseYaw: robot.sceneBinding.baseYaw,
          urdfPath: robot.sceneBinding.urdfPath,
          primPath: robot.sceneBinding.primPath,
          rosNamespace: robot.sceneBinding.rosNamespace,
          graphPath: robot.sceneBinding.graphPath
        }
      : null
  }
}

function hasPersistedSceneBinding(robot: BackendRobot, expected: RobotSceneBinding): boolean {
  const actual = robot.sceneBinding
  if (!actual) return false

  const tolerance = 0.001

  return (
    Math.abs(actual.baseX - expected.baseX) <= tolerance &&
    Math.abs(actual.baseY - expected.baseY) <= tolerance &&
    Math.abs(actual.baseZ - expected.baseZ) <= tolerance &&
    Math.abs(actual.baseYaw - expected.baseYaw) <= tolerance
  )
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
}

interface RobotSidebarProps {
  simulatorConfig: BackendSimulatorConfig
  simulatorConfigByRobotId: BackendSimulatorConfigByRobotId
  simulatorStatus: BackendSimulatorStatus
  onSimulatorConfigChange: (config: BackendSimulatorConfig) => void
  onSimulatorConnect: () => Promise<void>
  onSimulatorDisconnect: () => void
  onSimulatorConfigsImport: (configs: BackendSimulatorConfigByRobotId) => void
  onSimulatorConnectRobot: (config: BackendSimulatorConfig) => Promise<void>
  onSimulatorDisconnectRobot: (robotId: string) => void
}

export default function RobotSidebar({
  simulatorConfig,
  simulatorConfigByRobotId,
  simulatorStatus,
  onSimulatorConfigChange,
  onSimulatorConnect,
  onSimulatorDisconnect,
  onSimulatorConfigsImport,
  onSimulatorConnectRobot,
  onSimulatorDisconnectRobot
}: RobotSidebarProps): ReactElement {
  const [activeTab, setActiveTab] = useState<'robot' | 'connection' | 'scene'>('robot')
  const [isHoming, setIsHoming] = useState(false)
  const [isAddRobotOpen, setIsAddRobotOpen] = useState(false)
  const [addRobotCompanyId, setAddRobotCompanyId] = useState(
    () => window.localStorage.getItem(ADD_ROBOT_COMPANY_KEY) || ''
  )

  const [backendCompanies, setBackendCompanies] = useState<BackendCompany[]>([])
  const [companyListLoading, setCompanyListLoading] = useState(false)
  const [companyListResolved, setCompanyListResolved] = useState(false)
  const [backendRobots, setBackendRobots] = useState<BackendRobot[]>([])
  const [robotListLoading, setRobotListLoading] = useState(false)
  const [robotListError, setRobotListError] = useState('')
  const [credentialImportFeedback, setCredentialImportFeedback] = useState<{
    status: 'success' | 'error'
    message: string
  } | null>(null)
  const [deletingRobotId, setDeletingRobotId] = useState('')
  const [factoryActionBusy, setFactoryActionBusy] = useState(false)
  const [robotListReloadRevision, setRobotListReloadRevision] = useState(0)
  const openSingleFactoryProgram = useFactoryProgramStore((state) => state.openSingle)
  const openBatchFactoryProgram = useFactoryProgramStore((state) => state.openBatch)
  const [sceneBindingSaveFeedback, setSceneBindingSaveFeedback] = useState<
    Record<string, SceneBindingSaveFeedback>
  >({})
  const [commandRecoveryFeedback, setCommandRecoveryFeedback] = useState<
    Record<string, CommandRecoveryFeedback>
  >({})
  const [bulkCommandRecoveryFeedback, setBulkCommandRecoveryFeedback] =
    useState<CommandRecoveryFeedback | null>(null)
  const homeRunIdRef = useRef(0)
  const robotListAutoLoadKeyRef = useRef('')
  const robotListAbortControllerRef = useRef<AbortController | null>(null)
  const robotListRetryTimeoutRef = useRef<number | null>(null)
  const credentialFileInputRef = useRef<HTMLInputElement | null>(null)
  const robotCardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // Joint/TCP controls are only rendered in Training. Returning stable values in Factory prevents
  // the complete (and intentionally feature-rich) sidebar from re-rendering for every motion frame.
  const jointAngles = useRobotStore((state) =>
    state.workspaceMode === 'train' ? state.jointAngles : DEFAULT_JOINT_ANGLES
  )
  const setJointAngles = useRobotStore((state) => state.setJointAngles)
  const setPlaying = useRobotStore((state) => state.setPlaying)
  const isPlaying = useRobotStore((state) => {
    const robotId = state.selectedRobotId

    return robotId ? (state.robotExecutionById[robotId]?.isPlaying ?? false) : state.isPlaying
  })
  const setCurrentStepIndex = useRobotStore((state) => state.setCurrentStepIndex)
  const setSelectedStepId = useRobotStore((state) => state.setSelectedStepId)
  const tcpPose = useRobotStore((state) =>
    state.workspaceMode === 'train' ? state.tcpPose : FACTORY_SIDEBAR_TCP_POSE
  )
  const isIKMode = useRobotStore((state) => state.isIKMode)
  const isRobotPlacementMode = useRobotStore((state) => state.isRobotPlacementMode)
  const setRobotPlacementMode = useRobotStore((state) => state.setRobotPlacementMode)
  const robotPlacementTransformMode = useRobotStore((state) => state.robotPlacementTransformMode)
  const setRobotPlacementTransformMode = useRobotStore(
    (state) => state.setRobotPlacementTransformMode
  )
  const setIKMode = useRobotStore((state) => state.setIKMode)
  const cartesianInteractionMode = useRobotStore((state) => state.cartesianInteractionMode)
  const setCartesianInteractionMode = useRobotStore((state) => state.setCartesianInteractionMode)
  const selectedJointName = useRobotStore((state) => state.selectedJointName)
  const setSelectedJointName = useRobotStore((state) => state.setSelectedJointName)

  const lengthUnit = useRobotStore((state) => state.lengthUnit)
  const setLengthUnit = useRobotStore((state) => state.setLengthUnit)
  const angleUnit = useRobotStore((state) => state.angleUnit)
  const setAngleUnit = useRobotStore((state) => state.setAngleUnit)

  const isDebugHitbox = useSceneStore((state) => state.isDebugHitbox)
  const setDebugHitbox = useSceneStore((state) => state.setDebugHitbox)
  const robotFaultsById = useSceneStore((state) => state.robotFaultsById)
  const robotContactsById = useSceneStore((state) => state.robotContactsById)
  const recoverableCommandFaultRobotIds = Object.values(robotFaultsById)
    .filter((fault) => fault.active && (fault.kind === 'command' || fault.kind === 'timeout'))
    .map((fault) => fault.robotId)

  const language = useRobotStore((state) => state.language)
  const t = (key: keyof typeof translations.vi): string => translations[language][key]
  const backendToken = useBackendAuthStore((state) => state.accessToken)
  const backendConnectivity = useBackendAuthStore((state) => state.connectivity)
  const setBackendConnectivity = useBackendAuthStore((state) => state.setConnectivity)
  const clearBackendAccessToken = useBackendAuthStore((state) => state.clearAccessToken)
  const selectedRobotId = useRobotStore((state) => state.selectedRobotId)
  const workspaceMode = useRobotStore((state) => state.workspaceMode)
  const robotRuntimeById = useRobotStore((state) => state.robotRuntimeById)
  const robotExecutionById = useRobotStore((state) => state.robotExecutionById)
  const robots = useRobotStore((state) => state.robots)
  const setRobots = useRobotStore((state) => state.setRobots)
  const upsertRobot = useRobotStore((state) => state.upsertRobot)
  const selectRobot = useRobotStore((state) => state.selectRobot)
  const removeRobot = useRobotStore((state) => state.removeRobot)
  const updateRobotSceneBinding = useRobotStore((state) => state.updateRobotSceneBinding)
  const setJointAnglesForRobot = useRobotStore((state) => state.setJointAnglesForRobot)

  const [width, setWidth] = useState<number>(() => {
    const saved = window.localStorage.getItem('fai_sidebar_width')
    if (saved) {
      const val = parseInt(saved, 10)
      if (!isNaN(val)) return Math.max(320, Math.min(620, val))
    }
    return 400 // default
  })

  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    const saved = window.localStorage.getItem('fai_sidebar_collapsed')
    return saved === 'true'
  })

  const [homingStatuses, setHomingStatuses] = useState<
    Record<string, 'idle' | 'homing' | 'success' | 'failed'>
  >({})

  const latestWidthRef = useRef(width)
  useEffect(() => {
    latestWidthRef.current = width
  }, [width])

  const isResizingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(0)

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    isResizingRef.current = true
    dragStartXRef.current = e.clientX
    dragStartWidthRef.current = width
    e.currentTarget.setPointerCapture(e.pointerId)
    e.stopPropagation()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!isResizingRef.current) return
    e.stopPropagation()
    const currentX = e.clientX
    const deltaX = currentX - dragStartXRef.current
    const nextWidth = dragStartWidthRef.current + deltaX
    const maxWidth = Math.min(620, window.innerWidth * 0.45)
    const clamped = Math.max(320, Math.min(maxWidth, nextWidth))

    window.requestAnimationFrame(() => {
      if (isResizingRef.current) {
        setWidth(clamped)
      }
    })
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!isResizingRef.current) return
    isResizingRef.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    e.stopPropagation()
    window.localStorage.setItem('fai_sidebar_width', latestWidthRef.current.toString())
  }

  const handleDoubleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setWidth(400)
    window.localStorage.setItem('fai_sidebar_width', '400')
  }

  const toggleCollapse = (): void => {
    const next = !isCollapsed
    setIsCollapsed(next)
    window.localStorage.setItem('fai_sidebar_collapsed', next.toString())
  }

  const isFactoryRunning = backendRobots.some((r) => robotExecutionById[r.id]?.isPlaying)

  const enqueueMoveJCommand = async (
    context: BackendProgramContext,
    robotId: string,
    jointAngles: number[],
    speed = 30
  ): Promise<BackendCommandResponse> => {
    const response = await backendFetch(
      `${context.backendUrl.trim().replace(/\/+$/, '')}/api/robots/${encodeURIComponent(robotId)}/commands`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${context.token.trim()}`
        },
        body: JSON.stringify({
          commandType: 'MoveJ',
          payload: {
            jointAngles,
            speed
          }
        })
      }
    )
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    }
    return (await response.json()) as BackendCommandResponse
  }

  const homeSingleRobot = async (robot: BackendRobot): Promise<void> => {
    const isOnline = isBackendRobotRuntimeActive(robot)
    setHomingStatuses((prev) => ({ ...prev, [robot.id]: 'homing' }))

    try {
      if (isOnline) {
        const context = { backendUrl: simulatorConfig.backendUrl, token: backendToken }
        const cmd = await enqueueMoveJCommand(context, robot.id, DEFAULT_JOINT_ANGLES)
        const result = await waitForRobotCommand(context, robot.id, cmd.id)
        if (result.status === 'Completed') {
          setHomingStatuses((prev) => ({ ...prev, [robot.id]: 'success' }))
        } else {
          throw new Error(result.failureReason || 'Command failed')
        }
      } else {
        setJointAnglesForRobot(robot.id, [...DEFAULT_JOINT_ANGLES])
        setHomingStatuses((prev) => ({ ...prev, [robot.id]: 'success' }))
      }
    } catch (err) {
      console.error(`Homing failed for robot ${robot.id}:`, err)
      setHomingStatuses((prev) => ({ ...prev, [robot.id]: 'failed' }))
    }
  }

  const handleReturnAllHome = async (): Promise<void> => {
    if (isFactoryRunning) return
    const msg =
      language === 'vi'
        ? 'Đưa toàn bộ robot trong Factory về tư thế Home?'
        : 'Return all robots in the Factory to the Home pose?'
    if (!window.confirm(msg)) {
      return
    }

    const promises = backendRobots.map((robot) => homeSingleRobot(robot))
    await Promise.allSettled(promises)
  }

  const selectedRobot = robots.find((robot) => robot.id === selectedRobotId) ?? null
  const selectedRobotRuntime = selectedRobotId ? robotRuntimeById[selectedRobotId] : undefined
  const selectedRobotBadge = getRobotRuntimeBadge(selectedRobotRuntime ?? simulatorStatus)
  useEffect(() => {
    if (workspaceMode !== 'factory' || !selectedRobotId) return

    const frameId = window.requestAnimationFrame(() => {
      robotCardRefs.current[selectedRobotId]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      })
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [selectedRobotId, workspaceMode])
  const getLiveRobotSceneBinding = (robot: BackendRobot): RobotSceneBinding => {
    const storeRobot = robots.find((item) => item.id === robot.id)

    return storeRobot?.sceneBinding ?? toRobotSceneBinding(robot)
  }

  function getRobotSimulatorConfig(
    robot: BackendRobot,
    options?: {
      deviceSecret?: string
    }
  ): BackendSimulatorConfig {
    const savedConfig = simulatorConfigByRobotId[robot.id]
    const isCurrentConfig = simulatorConfig.robotId.trim() === robot.id
    const deviceSecret =
      options?.deviceSecret ??
      savedConfig?.deviceSecret ??
      (isCurrentConfig ? simulatorConfig.deviceSecret : '')

    return {
      ...simulatorConfig,
      ...savedConfig,
      robotId: robot.id,
      deviceSecret,
      enabled: savedConfig?.enabled ?? (isCurrentConfig ? simulatorConfig.enabled : false)
    }
  }

  function canConnectBackendRobot(robot: BackendRobot): boolean {
    const robotRuntime = robotRuntimeById[robot.id]
    const robotSimulatorConfig = getRobotSimulatorConfig(robot)

    return Boolean(
      backendToken &&
      !robotRuntime?.isRunning &&
      !robotRuntime?.isConnected &&
      robotSimulatorConfig.backendUrl.trim() &&
      robotSimulatorConfig.robotId.trim() &&
      robotSimulatorConfig.deviceSecret.trim()
    )
  }

  function isBackendRobotRuntimeActive(robot: BackendRobot): boolean {
    const robotRuntime = robotRuntimeById[robot.id]

    return Boolean(robotRuntime?.isRunning || robotRuntime?.isConnected)
  }

  const getFactoryRuntimeSummary = (): {
    total: number
    online: number
    ready: number
    running: number
    connecting: number
    error: number
    offline: number
  } => {
    let online = 0
    let running = 0
    let connecting = 0
    let error = 0
    let offline = 0

    for (const robot of backendRobots) {
      const execution = robotExecutionById[robot.id]

      if (execution?.isPlaying) {
        running += 1
      }
      const runtime = robotRuntimeById[robot.id]

      if (runtime?.lastError && !runtime.isConnected) {
        error += 1
      } else if (runtime?.isConnected) {
        online += 1
      } else if (runtime?.isRunning) {
        connecting += 1
      } else {
        offline += 1
      }
    }

    return {
      total: backendRobots.length,
      running,
      online,
      ready: backendRobots.filter((robot) => canConnectBackendRobot(robot)).length,
      connecting,
      error,
      offline
    }
  }

  const displayedActiveTab =
    workspaceMode === 'factory' && activeTab === 'robot' ? 'scene' : activeTab

  const factoryRuntimeSummary = getFactoryRuntimeSummary()
  const sidebarRobotName = selectedRobot?.name || 'Fairino FR5'
  const sidebarRobotSubtitle = selectedRobot
    ? `${selectedRobot.model} | ${selectedRobot.connectionType} | ${selectedRobot.status}`
    : `${t('payload')}: 5kg | ${t('reach')}: 924mm | 6-DOF`
  const handleAddRobotCompanyIdChange = (value: string): void => {
    setAddRobotCompanyId(value)
    window.localStorage.setItem(ADD_ROBOT_COMPANY_KEY, value)
  }

  const scheduleRobotListRetry = useCallback((): void => {
    if (robotListRetryTimeoutRef.current !== null) {
      window.clearTimeout(robotListRetryTimeoutRef.current)
    }

    robotListRetryTimeoutRef.current = window.setTimeout(() => {
      robotListRetryTimeoutRef.current = null
      robotListAutoLoadKeyRef.current = ''
      setRobotListReloadRevision((current) => current + 1)
    }, 3000)
  }, [])

  const loadBackendRobots = useCallback(async (): Promise<void> => {
    if (!backendToken) {
      setRobotListError(
        language === 'vi' ? 'Hãy đăng nhập tài khoản SynTwin trước.' : 'Sign in to SynTwin first.'
      )
      return
    }

    if (!simulatorConfig.backendUrl.trim()) {
      setRobotListError(
        language === 'vi'
          ? 'Chưa chọn môi trường kết nối.'
          : 'No connection environment is selected.'
      )
      return
    }

    if (!addRobotCompanyId.trim()) {
      setRobotListError(
        language === 'vi' ? 'Chưa chọn doanh nghiệp.' : 'No organization is selected.'
      )
      return
    }

    robotListAbortControllerRef.current?.abort()
    const controller = new AbortController()
    robotListAbortControllerRef.current = controller

    setRobotListLoading(true)
    setRobotListError('')
    setBackendConnectivity('checking')

    try {
      const robots = await listRobots(
        simulatorConfig.backendUrl,
        backendToken,
        addRobotCompanyId.trim(),
        controller.signal
      )

      if (robotListAbortControllerRef.current !== controller) return

      setBackendRobots(robots)
      setRobots(robots.map(toRobotInstance))
      setBackendConnectivity('online')

      if (robotListRetryTimeoutRef.current !== null) {
        window.clearTimeout(robotListRetryTimeoutRef.current)
        robotListRetryTimeoutRef.current = null
      }

      if (simulatorConfig.robotId && robots.some((robot) => robot.id === simulatorConfig.robotId)) {
        selectRobot(simulatorConfig.robotId)
      } else if (!simulatorConfig.robotId && robots.length > 0) {
        selectRobot(robots[0].id)
      }
    } catch (error) {
      if (controller.signal.aborted) return

      robotListAutoLoadKeyRef.current = ''

      if (error instanceof BackendRobotClientError && error.status === 401) {
        clearBackendAccessToken()
        setBackendRobots([])
        setRobotListError(
          language === 'vi'
            ? 'Phiên đăng nhập SynTwin đã hết hạn. Hãy đăng nhập lại.'
            : 'Your SynTwin session has expired. Please sign in again.'
        )
        return
      }

      const message =
        error instanceof Error
          ? error.message
          : language === 'vi'
            ? 'Không tải được danh sách robot.'
            : 'Unable to load the robot list.'
      setRobotListError(message)

      if (
        error instanceof BackendRobotClientError &&
        (error.status === 0 || error.status === 429 || error.status >= 500)
      ) {
        setBackendConnectivity('offline', message)
        scheduleRobotListRetry()
      } else {
        setBackendConnectivity('online', message)
      }
    } finally {
      if (robotListAbortControllerRef.current === controller) {
        robotListAbortControllerRef.current = null
        setRobotListLoading(false)
      }
    }
  }, [
    addRobotCompanyId,
    backendToken,
    clearBackendAccessToken,
    language,
    scheduleRobotListRetry,
    selectRobot,
    setBackendConnectivity,
    setRobots,
    simulatorConfig.backendUrl,
    simulatorConfig.robotId
  ])

  useEffect(() => {
    const backendUrl = simulatorConfig.backendUrl.trim()

    setCompanyListResolved(false)
    setBackendCompanies([])

    if (!backendToken || !backendUrl) {
      setCompanyListLoading(false)
      return
    }

    const controller = new AbortController()
    setCompanyListLoading(true)
    setRobotListError('')

    void listCompanies(backendUrl, backendToken, controller.signal)
      .then((companies) => {
        if (controller.signal.aborted) return

        setBackendCompanies(companies)
        setAddRobotCompanyId((currentCompanyId) => {
          const normalizedCurrentId = currentCompanyId.trim()
          const currentCompanyStillExists = companies.some(
            (company) => company.id === normalizedCurrentId
          )
          const selectedCompanyId = currentCompanyStillExists
            ? normalizedCurrentId
            : (companies.find((company) => company.currentUserRole === 'Owner')?.id ??
              companies[0]?.id ??
              '')

          if (selectedCompanyId) {
            window.localStorage.setItem(ADD_ROBOT_COMPANY_KEY, selectedCompanyId)
          } else {
            window.localStorage.removeItem(ADD_ROBOT_COMPANY_KEY)
          }

          return selectedCompanyId
        })
        setCompanyListResolved(true)
      })
      .catch((error) => {
        if (controller.signal.aborted) return

        if (error instanceof BackendRobotClientError && error.status === 401) {
          clearBackendAccessToken()
          setRobotListError(
            language === 'vi'
              ? 'Phiên đăng nhập SynTwin đã hết hạn. Hãy đăng nhập lại.'
              : 'Your SynTwin session has expired. Please sign in again.'
          )
          return
        }

        setRobotListError(
          error instanceof Error
            ? error.message
            : language === 'vi'
              ? 'Không tải được danh sách doanh nghiệp.'
              : 'Unable to load the organization list.'
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setCompanyListLoading(false)
        }
      })

    return () => controller.abort()
  }, [backendToken, clearBackendAccessToken, language, simulatorConfig.backendUrl])

  useEffect(() => {
    if (
      !companyListResolved ||
      !backendToken ||
      !simulatorConfig.backendUrl.trim() ||
      !addRobotCompanyId.trim()
    ) {
      return
    }

    const autoLoadKey = `${simulatorConfig.backendUrl}|${addRobotCompanyId.trim()}|${backendToken}`

    if (robotListAutoLoadKeyRef.current === autoLoadKey) {
      return
    }

    robotListAutoLoadKeyRef.current = autoLoadKey
    void loadBackendRobots()
  }, [
    addRobotCompanyId,
    backendToken,
    companyListResolved,
    loadBackendRobots,
    robotListReloadRevision,
    simulatorConfig.backendUrl
  ])

  useEffect(() => {
    const backendUrl = simulatorConfig.backendUrl.trim()

    if (!backendToken || !backendUrl) {
      setBackendConnectivity('unknown')
      return
    }

    const controller = new AbortController()

    const refreshHealth = async (): Promise<void> => {
      const previousConnectivity = useBackendAuthStore.getState().connectivity

      try {
        await checkBackendHealth(backendUrl, controller.signal)

        if (controller.signal.aborted) return

        setBackendConnectivity('online')

        if (previousConnectivity === 'offline') {
          robotListAutoLoadKeyRef.current = ''
          setRobotListReloadRevision((current) => current + 1)
        }
      } catch (error) {
        if (controller.signal.aborted) return

        const message =
          error instanceof Error
            ? error.message
            : language === 'vi'
              ? 'Dịch vụ SynTwin hiện không phản hồi.'
              : 'The SynTwin service is not responding.'
        setBackendConnectivity('offline', message)
      }
    }

    void refreshHealth()
    const intervalId = window.setInterval(() => void refreshHealth(), 5000)

    return () => {
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [backendToken, language, setBackendConnectivity, simulatorConfig.backendUrl])

  useEffect(
    () => () => {
      robotListAbortControllerRef.current?.abort()

      if (robotListRetryTimeoutRef.current !== null) {
        window.clearTimeout(robotListRetryTimeoutRef.current)
      }
    },
    []
  )

  useEffect(() => {
    if (backendToken) return

    robotListAbortControllerRef.current?.abort()
    robotListAbortControllerRef.current = null
    robotListAutoLoadKeyRef.current = ''
    robotCardRefs.current = {}
    setIsHoming(false)
    setIsAddRobotOpen(false)
    setAddRobotCompanyId('')
    setBackendCompanies([])
    setCompanyListLoading(false)
    setCompanyListResolved(false)
    setRobotListLoading(false)
    setBackendRobots([])
    setRobotListError('')
    setCredentialImportFeedback(null)
    setDeletingRobotId('')
    setFactoryActionBusy(false)
    setSceneBindingSaveFeedback({})
    setCommandRecoveryFeedback({})
    setBulkCommandRecoveryFeedback(null)
    window.localStorage.removeItem(ADD_ROBOT_COMPANY_KEY)

    if (credentialFileInputRef.current) {
      credentialFileInputRef.current.value = ''
    }

    if (robotListRetryTimeoutRef.current !== null) {
      window.clearTimeout(robotListRetryTimeoutRef.current)
      robotListRetryTimeoutRef.current = null
    }
  }, [backendToken])

  const handleJointChange = (idx: number, val: number): void => {
    const updated = [...jointAngles] as JointAngles
    updated[idx] = Math.round(val * 10) / 10
    setJointAngles(updated)
  }

  const handleCredentialFileChange = async (
    event: ChangeEvent<HTMLInputElement>
  ): Promise<void> => {
    const file = event.target.files?.[0]

    if (!file) return

    try {
      setCredentialImportFeedback(null)
      const parsed = JSON.parse(await file.text()) as unknown

      if (!Array.isArray(parsed)) {
        throw new Error(
          language === 'vi'
            ? 'Tệp thông tin kết nối không đúng định dạng.'
            : 'The connection information file has an invalid format.'
        )
      }

      const knownRobotIds = new Set(backendRobots.map((robot) => robot.id))
      const importedConfigs: BackendSimulatorConfigByRobotId = {}
      let ignoredCount = 0

      for (const item of parsed) {
        if (!item || typeof item !== 'object') {
          ignoredCount += 1
          continue
        }

        const credential = item as Record<string, unknown>
        const robotId = typeof credential.robotId === 'string' ? credential.robotId.trim() : ''
        const deviceSecret =
          typeof credential.deviceSecret === 'string' ? credential.deviceSecret.trim() : ''

        if (!robotId || !deviceSecret || !knownRobotIds.has(robotId)) {
          ignoredCount += 1
          continue
        }

        importedConfigs[robotId] = {
          ...simulatorConfig,
          ...simulatorConfigByRobotId[robotId],
          backendUrl: simulatorConfig.backendUrl.trim(),
          robotId,
          deviceSecret,
          enabled: false
        }
      }

      const importedCount = Object.keys(importedConfigs).length

      if (importedCount === 0) {
        throw new Error(
          language === 'vi'
            ? 'Không tìm thấy thông tin kết nối phù hợp với robot của doanh nghiệp hiện tại.'
            : 'No connection information matches robots in the current organization.'
        )
      }

      onSimulatorConfigsImport(importedConfigs)
      setCredentialImportFeedback({
        status: 'success',
        message:
          ignoredCount > 0
            ? language === 'vi'
              ? `Đã nạp khóa kết nối cho ${importedCount} robot; bỏ qua ${ignoredCount} mục không hợp lệ hoặc không thuộc doanh nghiệp.`
              : `Connection keys were loaded for ${importedCount} robots; ${ignoredCount} invalid or unrelated entries were skipped.`
            : language === 'vi'
              ? `Đã nạp khóa kết nối cho ${importedCount} robot. Robot đã sẵn sàng kết nối.`
              : `Connection keys were loaded for ${importedCount} robots. They are ready to connect.`
      })
    } catch (error) {
      setCredentialImportFeedback({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : language === 'vi'
              ? 'Không đọc được tệp thông tin kết nối robot.'
              : 'Unable to read the robot connection information file.'
      })
    } finally {
      event.target.value = ''
    }
  }

  const handleConnectReadyRobots = async (): Promise<void> => {
    const readyRobots = backendRobots.filter((robot) => canConnectBackendRobot(robot))

    if (readyRobots.length === 0) {
      setRobotListError(
        language === 'vi'
          ? 'Chưa có robot nào có đủ mã robot và khóa kết nối.'
          : 'No robot has both a robot code and connection key yet.'
      )
      return
    }

    setFactoryActionBusy(true)
    setRobotListError('')

    try {
      for (const robot of readyRobots) {
        await onSimulatorConnectRobot(getRobotSimulatorConfig(robot))
        await wait(150)
      }
    } finally {
      setFactoryActionBusy(false)
    }
  }

  const handleDisconnectOnlineRobots = async (): Promise<void> => {
    const onlineRobots = backendRobots.filter((robot) => isBackendRobotRuntimeActive(robot))

    if (onlineRobots.length === 0) {
      setRobotListError(
        language === 'vi'
          ? 'Không có robot nào đang trực tuyến để ngắt kết nối.'
          : 'No online robot is available to disconnect.'
      )
      return
    }

    setFactoryActionBusy(true)
    setRobotListError('')

    try {
      for (const robot of onlineRobots) {
        onSimulatorDisconnectRobot(robot.id)
        await wait(50)
      }
    } finally {
      setFactoryActionBusy(false)
    }
  }

  const handleStopAllRobotMotion = (): void => {
    cancelAllActiveCommands('Factory Stop All requested')

    const store = useRobotStore.getState()

    for (const [robotId, execution] of Object.entries(store.robotExecutionById)) {
      if (execution.isPlaying) {
        store.setRobotExecution(robotId, {
          isPlaying: false,
          currentStepIndex: 0
        })
      }
    }

    store.setPlaying(false)
    store.setCurrentStepIndex(0)
    store.setSelectedStepId(null)

    setRobotListError('')
  }

  const handleRecoverRobotCommand = async (robotId: string): Promise<void> => {
    setCommandRecoveryFeedback((current) => ({
      ...current,
      [robotId]: { status: 'working', message: 'Đang kiểm tra và giải phóng command cũ...' }
    }))

    try {
      const result = await recoverRobotCommandFault(robotId)

      setCommandRecoveryFeedback((current) => ({
        ...current,
        [robotId]: {
          status: result.recovered ? 'success' : 'error',
          message: result.message
        }
      }))
    } catch (error) {
      setCommandRecoveryFeedback((current) => ({
        ...current,
        [robotId]: {
          status: 'error',
          message: error instanceof Error ? error.message : 'Không thể khôi phục command.'
        }
      }))
    }
  }

  const handleRecoverAllRobotCommands = async (): Promise<void> => {
    if (recoverableCommandFaultRobotIds.length === 0) return

    const confirmed = window.confirm(
      language === 'vi'
        ? `Khôi phục lỗi command/timeout cho ${recoverableCommandFaultRobotIds.length} robot? Collision và E-Stop sẽ không bị xóa.`
        : `Recover command/timeout faults for ${recoverableCommandFaultRobotIds.length} robots? Collision and E-Stop will not be cleared.`
    )
    if (!confirmed) return

    setBulkCommandRecoveryFeedback({
      status: 'working',
      message: 'Đang kiểm tra và khôi phục các command bị kẹt...'
    })
    setCommandRecoveryFeedback((current) => {
      const next = { ...current }
      for (const robotId of recoverableCommandFaultRobotIds) {
        next[robotId] = { status: 'working', message: 'Đang khôi phục cùng Factory...' }
      }
      return next
    })

    try {
      const result = await recoverAllRobotCommandFaults()
      const failedRobotIds = Object.keys(result.failedByRobotId)

      setCommandRecoveryFeedback((current) => {
        const next = { ...current }
        for (const robotId of result.recoveredRobotIds) {
          next[robotId] = {
            status: 'success',
            message: 'Đã xóa trạng thái lỗi. Robot có thể nhận chương trình mới.'
          }
        }
        for (const robotId of failedRobotIds) {
          next[robotId] = { status: 'error', message: result.failedByRobotId[robotId] }
        }
        return next
      })

      setBulkCommandRecoveryFeedback({
        status: failedRobotIds.length === 0 ? 'success' : 'error',
        message:
          failedRobotIds.length === 0
            ? `Đã khôi phục ${result.recoveredRobotIds.length} robot. Có thể chạy chương trình mới.`
            : `Đã khôi phục ${result.recoveredRobotIds.length} robot; ${failedRobotIds.length} robot chưa đủ điều kiện an toàn.`
      })
    } catch (error) {
      setBulkCommandRecoveryFeedback({
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Không thể khôi phục command toàn Factory.'
      })
    }
  }
  const handleSelectBackendRobot = (
    robot: BackendRobot,
    options?: {
      deviceSecret?: string
      switchToConnection?: boolean
    }
  ): void => {
    const backendRobotInstance = toRobotInstance(robot)
    const currentRobot = useRobotStore.getState().robots.find((item) => item.id === robot.id)

    upsertRobot({
      ...backendRobotInstance,
      sceneBinding: currentRobot?.sceneBinding ?? backendRobotInstance.sceneBinding
    })

    selectRobot(robot.id)
    onSimulatorConfigChange(getRobotSimulatorConfig(robot, options))

    if (options?.switchToConnection === true) {
      setActiveTab('connection')
    }
  }
  const handleDeleteBackendRobot = async (robot: BackendRobot): Promise<void> => {
    if (!backendToken) {
      setRobotListError(
        language === 'vi'
          ? 'Hãy đăng nhập tài khoản SynTwin trước khi xóa robot.'
          : 'Sign in to SynTwin before deleting a robot.'
      )
      return
    }

    if (!simulatorConfig.backendUrl.trim()) {
      setRobotListError(
        language === 'vi'
          ? 'Chưa chọn môi trường kết nối.'
          : 'No connection environment is selected.'
      )
      return
    }

    if (isBackendRobotRuntimeActive(robot)) {
      setRobotListError(
        language === 'vi'
          ? 'Không thể xóa robot đang trực tuyến. Hãy ngắt kết nối robot trước.'
          : 'An online robot cannot be deleted. Disconnect it first.'
      )
      return
    }

    const confirmed = window.confirm(
      language === 'vi'
        ? `Xóa robot "${robot.robotName}" khỏi danh sách sử dụng?\n\nRobot sẽ được vô hiệu hóa trên hệ thống SynTwin.`
        : `Remove "${robot.robotName}" from the active robot list?\n\nThe robot will be disabled in SynTwin.`
    )

    if (!confirmed) return

    setDeletingRobotId(robot.id)
    setRobotListError('')

    try {
      await deleteRobot(simulatorConfig.backendUrl, backendToken, robot.id)

      setBackendRobots((current) => current.filter((item) => item.id !== robot.id))
      removeRobot(robot.id)

      if (selectedRobotId === robot.id || simulatorConfig.robotId === robot.id) {
        onSimulatorDisconnect()
        onSimulatorConfigChange({
          ...simulatorConfig,
          enabled: false,
          robotId: '',
          deviceSecret: ''
        })
      }
    } catch (error) {
      setRobotListError(
        error instanceof Error
          ? error.message
          : language === 'vi'
            ? 'Không xóa được robot.'
            : 'Unable to delete the robot.'
      )
    } finally {
      setDeletingRobotId('')
    }
  }

  const handleSceneBindingNumberChange = (
    robot: BackendRobot,
    field: 'baseX' | 'baseY' | 'baseZ' | 'baseYaw',
    value: string
  ): void => {
    if (isBackendRobotRuntimeActive(robot)) {
      setRobotListError(
        language === 'vi'
          ? 'Không thể sửa vị trí khi robot đang trực tuyến. Hãy ngắt kết nối trước.'
          : 'The position cannot be edited while the robot is online. Disconnect it first.'
      )
      return
    }
    const numericValue = Number(value)

    if (!Number.isFinite(numericValue)) return

    const nextSceneBinding = {
      ...getLiveRobotSceneBinding(robot),
      [field]: numericValue
    }

    const nextRobot: BackendRobot = {
      ...robot,
      sceneBinding: {
        id: nextSceneBinding.id || '',
        robotId: robot.id,
        sceneType: nextSceneBinding.sceneType,
        baseX: nextSceneBinding.baseX,
        baseY: nextSceneBinding.baseY,
        baseZ: nextSceneBinding.baseZ,
        baseYaw: nextSceneBinding.baseYaw,
        urdfPath: nextSceneBinding.urdfPath,
        primPath: nextSceneBinding.primPath,
        rosNamespace: nextSceneBinding.rosNamespace,
        graphPath: nextSceneBinding.graphPath,
        createdAt: robot.sceneBinding?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }

    setBackendRobots((current) => current.map((item) => (item.id === robot.id ? nextRobot : item)))
    updateRobotSceneBinding(robot.id, nextSceneBinding)
  }

  const handleSaveSceneBinding = async (robot: BackendRobot): Promise<void> => {
    const setFeedback = (status: SceneBindingSaveFeedback['status'], message: string): void => {
      setSceneBindingSaveFeedback((current) => ({
        ...current,
        [robot.id]: { status, message }
      }))
    }

    if (isBackendRobotRuntimeActive(robot)) {
      const message =
        language === 'vi'
          ? 'Hãy ngắt kết nối robot trước khi lưu vị trí.'
          : 'Disconnect the robot before saving its position.'

      setRobotListError(message)
      setFeedback('error', message)
      return
    }

    if (!backendToken) {
      const message =
        language === 'vi'
          ? 'Hãy đăng nhập tài khoản SynTwin trước khi lưu vị trí.'
          : 'Sign in to SynTwin before saving the position.'
      setRobotListError(message)
      setFeedback('error', message)
      return
    }

    if (!simulatorConfig.backendUrl.trim()) {
      const message =
        language === 'vi'
          ? 'Chưa chọn môi trường kết nối.'
          : 'No connection environment is selected.'
      setRobotListError(message)
      setFeedback('error', message)
      return
    }

    const expectedBinding = getLiveRobotSceneBinding(robot)
    setFeedback(
      'saving',
      language === 'vi' ? 'Đang lưu vị trí lên SynTwin...' : 'Saving the position to SynTwin...'
    )

    try {
      await updateBackendRobotSceneBinding(simulatorConfig.backendUrl, backendToken, robot.id, {
        sceneType: expectedBinding.sceneType,
        baseX: expectedBinding.baseX,
        baseY: expectedBinding.baseY,
        baseZ: expectedBinding.baseZ,
        baseYaw: expectedBinding.baseYaw,
        urdfPath: expectedBinding.urdfPath,
        primPath: expectedBinding.primPath,
        rosNamespace: expectedBinding.rosNamespace,
        graphPath: expectedBinding.graphPath
      })

      const refreshedRobots = await listRobots(
        simulatorConfig.backendUrl,
        backendToken,
        addRobotCompanyId.trim() || undefined
      )

      const persistedRobot = refreshedRobots.find((item) => item.id === robot.id)

      if (!persistedRobot || !hasPersistedSceneBinding(persistedRobot, expectedBinding)) {
        throw new Error(
          language === 'vi'
            ? 'SynTwin chưa xác nhận đúng vị trí vừa lưu.'
            : 'SynTwin did not confirm the saved position correctly.'
        )
      }

      setBackendRobots((current) =>
        current.map((item) => (item.id === persistedRobot.id ? persistedRobot : item))
      )

      upsertRobot(toRobotInstance(persistedRobot))
      selectRobot(persistedRobot.id)

      // The persisted binding is now the new locked position. Leaving placement mode only after
      // the read-back verification succeeds detaches the viewport gizmo without hiding it when a
      // save fails and the user still needs to correct the position.
      setRobotPlacementMode(false)

      setRobotListError('')
      setFeedback('success', `Đã lưu thành công lúc ${new Date().toLocaleTimeString()}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không lưu được vị trí robot.'

      setRobotListError(message)
      setFeedback('error', message)
    }
  }
  const animateHome = async (runId: number, startAngles: JointAngles): Promise<void> => {
    const maxDelta = Math.max(
      ...DEFAULT_JOINT_ANGLES.map((target, index) => Math.abs(target - startAngles[index]))
    )
    const durationMs = clamp(500 + maxDelta * 7, 700, 1800)
    const frameMs = 1000 / 60
    const frameCount = Math.max(1, Math.ceil(durationMs / frameMs))

    try {
      for (let frame = 1; frame <= frameCount; frame++) {
        if (homeRunIdRef.current !== runId) {
          return
        }

        const progress = easeInOutCubic(frame / frameCount)
        const nextAngles = startAngles.map((start, index) => {
          const target = DEFAULT_JOINT_ANGLES[index]
          return Math.round((start + (target - start) * progress) * 10) / 10
        }) as JointAngles

        setJointAngles(nextAngles)
        await wait(frameMs)
      }

      if (homeRunIdRef.current === runId) {
        setJointAngles([...DEFAULT_JOINT_ANGLES])
      }
    } finally {
      if (homeRunIdRef.current === runId) {
        setIsHoming(false)
      }
    }
  }

  const handleHome = (): void => {
    const runId = homeRunIdRef.current + 1
    homeRunIdRef.current = runId

    cancelActiveCommand('Robot reset to home pose')
    setPlaying(false)
    setCurrentStepIndex(0)
    setSelectedStepId(null)
    setSelectedJointName(null)
    setIKMode(false)
    setIsHoming(true)

    void animateHome(runId, [...useRobotStore.getState().jointAngles] as JointAngles)
  }

  const statusBadgeColor =
    isPlaying && selectedRobotRuntime?.isConnected
      ? 'border border-emerald-500/40 bg-emerald-500/25 text-emerald-300 animate-pulse'
      : selectedRobotBadge.color
  const statusBadgeLabel =
    isPlaying && selectedRobotRuntime?.isConnected ? 'ACTIVE' : selectedRobotBadge.label
  const dotColor =
    isPlaying && selectedRobotRuntime?.isConnected ? 'bg-emerald-400' : selectedRobotBadge.dot

  if (isCollapsed) {
    return (
      <div
        className="relative flex h-full w-[60px] shrink-0 select-none flex-col border-r border-[#2d2d34] bg-[#1b1b1f] text-slate-200 items-center py-4 gap-4"
        style={{ width: '60px' }}
      >
        <button
          type="button"
          onClick={toggleCollapse}
          title={language === 'vi' ? 'Mở rộng Sidebar' : 'Expand Sidebar'}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#343849] bg-[#1e1e24] text-slate-300 transition hover:bg-[#282830] hover:text-white"
        >
          <ChevronsRight size={16} />
        </button>

        <div className="h-px w-8 bg-[#2d2d34]" />

        <div className="flex flex-col gap-3 overflow-y-auto max-h-[calc(100%-80px)] w-full items-center px-1">
          {backendRobots.map((robot) => {
            const robotRuntime = robotRuntimeById[robot.id]
            const robotBadge = getRobotRuntimeBadge(robotRuntime)

            const contact = robotContactsById[robot.id]
            const isCollision =
              contact?.level === 'collision' ||
              (robotFaultsById[robot.id]?.active &&
                (robotFaultsById[robot.id]?.kind === 'collision' ||
                  robotFaultsById[robot.id]?.code.startsWith('COLLISION_')))
            const isProximity = contact?.level === 'proximity'

            const statusColor = isCollision
              ? 'bg-red-500 shadow-[0_0_8px_#ef4444]'
              : isProximity
                ? 'bg-amber-500 shadow-[0_0_8px_#f59e0b]'
                : robotBadge.dot.includes('bg-emerald')
                  ? 'bg-emerald-500'
                  : robotBadge.dot.includes('bg-blue')
                    ? 'bg-blue-500'
                    : 'bg-slate-500'

            return (
              <div
                key={robot.id}
                className={`h-3 w-3 rounded-full ${statusColor}`}
                title={`${robot.robotName}: ${isCollision ? 'Va chạm' : isProximity ? 'Gần va chạm' : robotBadge.label}`}
              />
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full shrink-0 select-none flex-col border-r border-[#2d2d34] bg-[#1b1b1f] text-slate-200"
      style={{ width: `${width}px` }}
    >
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        className="absolute top-0 right-0 z-50 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-blue-500/50 active:bg-blue-500 transition-colors"
        title={
          language === 'vi'
            ? 'Kéo để đổi kích thước, nhấn đúp để khôi phục'
            : 'Drag to resize, double click to reset'
        }
      />

      <div className="border-b border-[#2d2d34] p-4 bg-[#141417]/20">
        <div className="flex items-center justify-between gap-2">
          <h2
            className="truncate text-sm font-bold leading-tight text-white flex-1"
            title={sidebarRobotName}
          >
            {sidebarRobotName}
          </h2>
          <div className="flex items-center gap-1.5 shrink-0">
            <div
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold ${statusBadgeColor}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
              <span>{statusBadgeLabel}</span>
            </div>

            <button
              type="button"
              onClick={toggleCollapse}
              title={language === 'vi' ? 'Thu nhỏ Sidebar' : 'Collapse Sidebar'}
              className="flex h-5 w-5 items-center justify-center rounded border border-[#343849] bg-[#1e1e24] text-slate-300 transition hover:bg-[#282830] hover:text-white"
            >
              <ChevronsLeft size={12} />
            </button>
          </div>
        </div>
        <p className="mt-1.5 truncate text-[10px] text-slate-400" title={sidebarRobotSubtitle}>
          {sidebarRobotSubtitle}
        </p>
      </div>

      <div className="flex border-b border-[#2d2d34] bg-[#141417]">
        {workspaceMode === 'train' && (
          <button
            type="button"
            onClick={() => setActiveTab('robot')}
            className={`flex flex-1 items-center justify-center gap-1 py-2 text-[11px] font-semibold transition ${
              displayedActiveTab === 'robot'
                ? 'border-b-2 border-blue-500 bg-[#1b1b1f] text-white'
                : 'border-b-2 border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu size={13} />
            Robot
          </button>
        )}

        <button
          type="button"
          onClick={() => setActiveTab('connection')}
          className={`flex flex-1 items-center justify-center gap-1 py-2 text-[11px] font-semibold transition ${
            displayedActiveTab === 'connection'
              ? 'border-b-2 border-blue-500 bg-[#1b1b1f] text-white'
              : 'border-b-2 border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Server size={13} />
          Connection
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('scene')}
          className={`flex flex-1 items-center justify-center gap-1 py-2 text-[11px] font-semibold transition ${
            displayedActiveTab === 'scene'
              ? 'border-b-2 border-blue-500 bg-[#1b1b1f] text-white'
              : 'border-b-2 border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Settings size={13} />
          {workspaceMode === 'factory' ? 'Factory' : t('deviceList')}
        </button>
      </div>

      {displayedActiveTab === 'robot' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-[#2d2d34] p-4">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              {t('controlMode')}
            </span>
            <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg bg-[#121214] p-1">
              <button
                type="button"
                onClick={() => setIKMode(false)}
                className={`flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition ${
                  !isIKMode ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
                }`}
              >
                Joint (FK)
                <InfoTooltip text={t('tooltipFK')} />
              </button>
              <button
                type="button"
                onClick={() => setIKMode(true)}
                className={`flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition ${
                  isIKMode ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
                }`}
              >
                Cartesian (IK)
                <InfoTooltip text={t('tooltipIK')} />
              </button>
            </div>
            {isIKMode && (
              <div className="mt-2 rounded-lg border border-cyan-500/20 bg-cyan-950/10 p-2">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-300">
                  {language === 'vi' ? 'Cách điều khiển Cartesian' : 'Cartesian interaction'}
                </div>
                <div className="grid grid-cols-2 gap-1 rounded-md bg-[#101014] p-1">
                  <button
                    type="button"
                    onClick={() => setCartesianInteractionMode('point')}
                    className={`rounded px-2 py-1.5 text-[10px] font-semibold transition ${
                      cartesianInteractionMode === 'point'
                        ? 'bg-cyan-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {language === 'vi' ? 'Điểm / Gizmo' : 'Point / Gizmo'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCartesianInteractionMode('trace')}
                    className={`rounded px-2 py-1.5 text-[10px] font-semibold transition ${
                      cartesianInteractionMode === 'trace'
                        ? 'bg-cyan-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {language === 'vi' ? 'Vẽ quỹ đạo' : 'Trace path'}
                  </button>
                </div>
                {cartesianInteractionMode === 'trace' && (
                  <p className="mt-1.5 text-[9px] leading-relaxed text-slate-400">
                    {language === 'vi'
                      ? 'Mở biểu tượng (!) ở góc trên khung nhìn để xem điều khiển chuột, J4–J6 và tốc độ.'
                      : 'Open the (!) icon at the top of the viewport for mouse, J4–J6 and speed controls.'}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between border-b border-[#2d2d34] bg-[#141417]/50 px-4 py-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Đơn vị đo / Units
            </span>
            <div className="flex gap-2">
              <div className="flex rounded border border-[#2d2d34] bg-[#121214] p-0.5">
                <button
                  type="button"
                  onClick={() => setLengthUnit('mm')}
                  className={`rounded px-2 py-0.5 text-[10px] font-bold transition ${
                    lengthUnit === 'mm'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Milimet"
                >
                  mm
                </button>
                <button
                  type="button"
                  onClick={() => setLengthUnit('m')}
                  className={`rounded px-2 py-0.5 text-[10px] font-bold transition ${
                    lengthUnit === 'm'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Mét"
                >
                  m
                </button>
              </div>
              <div className="flex rounded border border-[#2d2d34] bg-[#121214] p-0.5">
                <button
                  type="button"
                  onClick={() => setAngleUnit('deg')}
                  className={`rounded px-2 py-0.5 text-[10px] font-bold transition ${
                    angleUnit === 'deg'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Độ"
                >
                  °
                </button>
                <button
                  type="button"
                  onClick={() => setAngleUnit('rad')}
                  className={`rounded px-2 py-0.5 text-[10px] font-bold transition ${
                    angleUnit === 'rad'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Radian"
                >
                  rad
                </button>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-between border-b border-[#2d2d34] bg-[#141417]/30 px-4 py-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              {t('debugHitbox')}
            </span>
            <label className="relative inline-flex cursor-pointer select-none items-center">
              <input
                type="checkbox"
                checked={isDebugHitbox}
                onChange={(event) => setDebugHitbox(event.target.checked)}
                className="peer sr-only"
              />
              <div className="relative h-5 w-9 rounded-full border border-[#393942] bg-[#25252b] transition after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-slate-400 after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-full peer-checked:after:bg-white" />
            </label>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                {t('jointSpace')}
              </span>
              <button
                type="button"
                onClick={handleHome}
                disabled={isHoming}
                title="Reset robot to home pose"
                className="flex items-center gap-1.5 rounded border border-blue-500/30 bg-blue-600/10 px-2 py-1 text-xs font-semibold text-blue-300 transition hover:border-blue-400 hover:bg-blue-600/20 hover:text-white disabled:cursor-wait disabled:opacity-60"
              >
                <Home size={12} />
                {isHoming ? 'Homing...' : 'Home'}
              </button>
            </div>
            {JOINT_BOUNDS.map((bound, idx) => {
              const jointName = `j${idx + 1}`
              const isSelected = selectedJointName === jointName && !isIKMode
              const displayName = `${t('jointLimitTitle')} ${idx + 1} (${jointName})`

              const jointValDisp =
                angleUnit === 'rad'
                  ? `${((jointAngles[idx] * Math.PI) / 180).toFixed(3)} rad`
                  : `${jointAngles[idx].toFixed(1)}°`

              return (
                <div
                  key={jointName}
                  onClick={() => !isIKMode && setSelectedJointName(jointName)}
                  className={`cursor-pointer rounded-lg border p-3 transition ${
                    isSelected
                      ? 'border-blue-500 bg-blue-950/20 shadow-md shadow-blue-500/10'
                      : 'border-[#232328] bg-[#121214] hover:border-[#2d2d35]'
                  }`}
                >
                  <div className="mb-1.5 flex justify-between text-xs font-medium">
                    <span className="flex items-center gap-1.5">
                      {isSelected && (
                        <span className="h-1.5 w-1.5 animate-ping rounded-full bg-blue-400" />
                      )}
                      {displayName}
                    </span>
                    <span className="font-mono text-blue-400">{jointValDisp}</span>
                  </div>
                  <input
                    type="range"
                    min={bound.min}
                    max={bound.max}
                    step="0.1"
                    value={jointAngles[idx]}
                    disabled={isIKMode}
                    onChange={(event) => handleJointChange(idx, parseFloat(event.target.value))}
                    className="h-1 w-full cursor-pointer appearance-none rounded-lg bg-[#2d2d34] accent-blue-500 disabled:opacity-50"
                  />
                  <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
                    <span>
                      {angleUnit === 'rad'
                        ? `${((bound.min * Math.PI) / 180).toFixed(2)} rad`
                        : `${bound.min}°`}
                    </span>
                    <span>
                      {angleUnit === 'rad'
                        ? `${((bound.max * Math.PI) / 180).toFixed(2)} rad`
                        : `${bound.max}°`}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="shrink-0 border-t border-[#2d2d34] bg-[#141417] p-4">
            <span className="mb-3 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
              {t('toolCenterPoint')}
              <InfoTooltip text={t('tooltipTCP')} />
            </span>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded border border-[#2d2d34] bg-[#1e1e24] p-2">
                <span className="block text-[10px] font-bold text-red-400">X ({lengthUnit})</span>
                <span className="font-mono text-sm font-semibold">
                  {lengthUnit === 'm' ? (tcpPose.x / 1000).toFixed(4) : tcpPose.x.toFixed(1)}
                </span>
              </div>
              <div className="rounded border border-[#2d2d34] bg-[#1e1e24] p-2">
                <span className="block text-[10px] font-bold text-emerald-400">
                  Y ({lengthUnit})
                </span>
                <span className="font-mono text-sm font-semibold">
                  {lengthUnit === 'm' ? (tcpPose.y / 1000).toFixed(4) : tcpPose.y.toFixed(1)}
                </span>
              </div>
              <div className="rounded border border-[#2d2d34] bg-[#1e1e24] p-2">
                <span className="block text-[10px] font-bold text-blue-400">Z ({lengthUnit})</span>
                <span className="font-mono text-sm font-semibold">
                  {lengthUnit === 'm' ? (tcpPose.z / 1000).toFixed(4) : tcpPose.z.toFixed(1)}
                </span>
              </div>
              <div className="rounded border border-[#2d2d34] bg-[#1e1e24] p-2">
                <span className="block text-[10px] font-bold text-red-300">
                  Rx ({angleUnit === 'rad' ? 'rad' : '°'})
                </span>
                <span className="font-mono text-sm font-semibold">
                  {angleUnit === 'rad'
                    ? ((tcpPose.rx * Math.PI) / 180).toFixed(3)
                    : tcpPose.rx.toFixed(1)}
                </span>
              </div>
              <div className="rounded border border-[#2d2d34] bg-[#1e1e24] p-2">
                <span className="block text-[10px] font-bold text-emerald-300">
                  Ry ({angleUnit === 'rad' ? 'rad' : '°'})
                </span>
                <span className="font-mono text-sm font-semibold">
                  {angleUnit === 'rad'
                    ? ((tcpPose.ry * Math.PI) / 180).toFixed(3)
                    : tcpPose.ry.toFixed(1)}
                </span>
              </div>
              <div className="rounded border border-[#2d2d34] bg-[#1e1e24] p-2">
                <span className="block text-[10px] font-bold text-blue-300">
                  Rz ({angleUnit === 'rad' ? 'rad' : '°'})
                </span>
                <span className="font-mono text-sm font-semibold">
                  {angleUnit === 'rad'
                    ? ((tcpPose.rz * Math.PI) / 180).toFixed(3)
                    : tcpPose.rz.toFixed(1)}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : displayedActiveTab === 'connection' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <BackendSimulatorPanel
            config={simulatorConfig}
            status={simulatorStatus}
            onConfigChange={onSimulatorConfigChange}
            onConnect={onSimulatorConnect}
            onDisconnect={onSimulatorDisconnect}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="border-b border-[#2d2d34] p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  {t('deviceManagement')}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">{t('deviceManagementHint')}</p>
              </div>

              <button
                type="button"
                onClick={() => setIsAddRobotOpen(true)}
                disabled={
                  !backendToken || !simulatorConfig.backendUrl.trim() || !addRobotCompanyId.trim()
                }
                className="flex shrink-0 items-center gap-1.5 rounded bg-blue-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  !backendToken
                    ? t('signInFirst')
                    : !addRobotCompanyId.trim()
                      ? t('chooseCompanyFirst')
                      : t('addRobot')
                }
              >
                <Plus size={13} />
                {t('addRobot')}
              </button>
            </div>

            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {t('company')}
              </span>
              <select
                value={addRobotCompanyId}
                onChange={(event) => handleAddRobotCompanyIdChange(event.target.value)}
                disabled={!backendToken || companyListLoading}
                className="mt-1 w-full rounded-md border border-[#2d2d34] bg-[#0c0e16] px-3 py-2 text-xs text-white outline-none transition focus:border-blue-500"
              >
                <option value="">
                  {companyListLoading
                    ? t('loadingCompanies')
                    : backendCompanies.length === 0
                      ? t('noCompanies')
                      : t('chooseCompany')}
                </option>
                {backendCompanies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name} ({company.currentUserRole})
                  </option>
                ))}
              </select>
              {addRobotCompanyId && (
                <span className="mt-1 block break-all text-[9px] text-slate-600">
                  {addRobotCompanyId}
                </span>
              )}
            </label>

            {!backendToken && (
              <p className="mt-2 rounded border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
                {t('signInToManageRobots')}
              </p>
            )}

            <div className="mt-3 border-t border-[#2d2d34] pt-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                {t('factoryActions')}
              </p>
              <button
                type="button"
                disabled={backendRobots.length === 0 || !backendToken || factoryActionBusy}
                onClick={() => openBatchFactoryProgram(backendRobots.map((robot) => robot.id))}
                className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FileCode2 size={14} />
                {t('importLuaRunFactory')}
              </button>

              <div className="grid grid-cols-2 gap-2 mb-3">
                <button
                  type="button"
                  onClick={() => void handleConnectReadyRobots()}
                  disabled={
                    factoryActionBusy ||
                    backendRobots.every((robot) => !canConnectBackendRobot(robot))
                  }
                  className="rounded-lg border border-emerald-500/40 bg-emerald-950/10 px-2 py-1.5 text-xs font-bold text-emerald-300 transition hover:bg-emerald-950/30 disabled:cursor-not-allowed disabled:opacity-40 text-center"
                  title={t('connectReadyHint')}
                >
                  {t('connectReady')}
                </button>

                <button
                  type="button"
                  onClick={handleStopAllRobotMotion}
                  disabled={factoryRuntimeSummary.running === 0}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-red-500/50 bg-red-950/15 px-2 py-1.5 text-xs font-bold text-red-300 transition hover:bg-red-950/35 disabled:cursor-not-allowed disabled:opacity-40"
                  title={t('stopAllHint')}
                >
                  <Square size={12} />
                  {t('stopAll')}
                </button>

                <button
                  type="button"
                  onClick={() => void handleDisconnectOnlineRobots()}
                  disabled={
                    factoryActionBusy ||
                    backendRobots.every((robot) => !isBackendRobotRuntimeActive(robot))
                  }
                  className="rounded-lg border border-amber-500/40 bg-amber-950/10 px-2 py-1.5 text-xs font-bold text-amber-300 transition hover:bg-amber-950/30 disabled:cursor-not-allowed disabled:opacity-40 text-center"
                  title={t('disconnectOnlineHint')}
                >
                  {t('disconnectOnline')}
                </button>

                <button
                  type="button"
                  onClick={handleReturnAllHome}
                  disabled={isFactoryRunning}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-blue-500/45 bg-blue-950/15 px-2 py-1.5 text-xs font-bold text-blue-300 transition hover:bg-blue-950/35 disabled:cursor-not-allowed disabled:opacity-40"
                  title={isFactoryRunning ? t('stopFactoryBeforeHome') : t('returnAllHomeHint')}
                >
                  <Home size={12} />
                  {t('returnAllHome')}
                </button>

                <button
                  type="button"
                  onClick={() => void handleRecoverAllRobotCommands()}
                  disabled={
                    recoverableCommandFaultRobotIds.length === 0 ||
                    bulkCommandRecoveryFeedback?.status === 'working'
                  }
                  className="col-span-2 flex items-center justify-center gap-1.5 rounded-lg border border-red-400/50 bg-red-950/20 px-2 py-2 text-xs font-bold text-red-200 transition hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Chỉ khôi phục lỗi command/timeout; không xóa collision hoặc Global E-Stop"
                >
                  <RefreshCw
                    size={12}
                    className={
                      bulkCommandRecoveryFeedback?.status === 'working' ? 'animate-spin' : ''
                    }
                  />
                  {bulkCommandRecoveryFeedback?.status === 'working'
                    ? 'Đang khôi phục tất cả...'
                    : `Khôi phục tất cả lỗi lệnh (${recoverableCommandFaultRobotIds.length})`}
                </button>

                {bulkCommandRecoveryFeedback &&
                  bulkCommandRecoveryFeedback.status !== 'working' && (
                    <p
                      className={`col-span-2 rounded border px-2 py-1.5 text-[9px] leading-relaxed ${
                        bulkCommandRecoveryFeedback.status === 'success'
                          ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
                          : 'border-red-500/30 bg-red-950/20 text-red-300'
                      }`}
                    >
                      {bulkCommandRecoveryFeedback.message}
                    </p>
                  )}
              </div>

              <div className="mb-2 flex justify-end gap-2">
                <input
                  ref={credentialFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(event) => void handleCredentialFileChange(event)}
                />
                <button
                  type="button"
                  onClick={() => credentialFileInputRef.current?.click()}
                  disabled={!backendToken || backendRobots.length === 0 || factoryActionBusy}
                  className="flex items-center gap-1 rounded border border-amber-500/40 px-2 py-1.5 text-[10px] font-semibold text-amber-300 transition hover:bg-amber-950/30 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                  title={t('importConnectionKeysHint')}
                >
                  <KeyRound size={11} />
                  {t('importConnectionKeys')}
                </button>
                <button
                  type="button"
                  onClick={() => void loadBackendRobots()}
                  disabled={
                    robotListLoading ||
                    factoryActionBusy ||
                    !backendToken ||
                    !simulatorConfig.backendUrl.trim() ||
                    !addRobotCompanyId.trim()
                  }
                  className="flex items-center gap-1 rounded border border-[#343849] px-2 py-1.5 text-[10px] font-semibold text-slate-300 transition hover:bg-[#242833] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RefreshCw size={11} className={robotListLoading ? 'animate-spin' : ''} />
                  {t('refresh')}
                </button>
              </div>
              {credentialImportFeedback && (
                <p
                  className={`mb-4 rounded border px-3 py-2 text-[10px] leading-relaxed ${
                    credentialImportFeedback.status === 'success'
                      ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
                      : 'border-red-500/40 bg-red-950/30 text-red-200'
                  }`}
                >
                  {credentialImportFeedback.message}
                </p>
              )}
            </div>

            {backendRobots.length > 0 && (
              <div className="mt-4 border-t border-[#2d2d34] pt-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                  {t('factorySummary')}
                </p>
                <div className="mb-4 grid grid-cols-3 gap-1 rounded border border-[#2d2d34] bg-[#080a10] p-2">
                  <div className="col-span-3 flex items-center justify-between rounded border border-violet-500/30 bg-violet-950/20 px-3 py-2">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-violet-300">
                      {t('runningRobots')}
                    </p>
                    <p className="text-base font-bold text-violet-200">
                      {factoryRuntimeSummary.running}
                    </p>
                  </div>
                  <div className="rounded bg-[#111827] px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
                      {t('total')}
                    </p>
                    <p className="text-sm font-bold text-white">{factoryRuntimeSummary.total}</p>
                  </div>

                  <div className="rounded bg-emerald-950/20 px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-emerald-500">
                      {t('online')}
                    </p>
                    <p className="text-sm font-bold text-emerald-300">
                      {factoryRuntimeSummary.online}
                    </p>
                  </div>

                  <div className="rounded bg-blue-950/20 px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-blue-400">
                      {t('ready')}
                    </p>
                    <p className="text-sm font-bold text-blue-300">{factoryRuntimeSummary.ready}</p>
                  </div>

                  <div className="rounded bg-amber-950/20 px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-amber-400">
                      {t('connecting')}
                    </p>
                    <p className="text-sm font-bold text-amber-300">
                      {factoryRuntimeSummary.connecting}
                    </p>
                  </div>

                  <div className="rounded bg-red-950/20 px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-red-400">
                      {t('error')}
                    </p>
                    <p className="text-sm font-bold text-red-300">{factoryRuntimeSummary.error}</p>
                  </div>

                  <div className="rounded bg-slate-900 px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
                      {t('offline')}
                    </p>
                    <p className="text-sm font-bold text-slate-300">
                      {factoryRuntimeSummary.offline}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {backendToken && backendConnectivity !== 'unknown' && (
              <p
                className={`mb-2 rounded border px-3 py-2 text-[11px] ${
                  backendConnectivity === 'online'
                    ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
                    : backendConnectivity === 'checking'
                      ? 'border-blue-500/30 bg-blue-950/20 text-blue-300'
                      : 'border-amber-500/40 bg-amber-950/25 text-amber-200'
                }`}
              >
                {backendConnectivity === 'online'
                  ? t('systemConnected')
                  : backendConnectivity === 'checking'
                    ? t('systemChecking')
                    : t('systemOfflineRetrying')}
              </p>
            )}

            {robotListError && (
              <p className="mb-2 rounded border border-red-500/40 bg-red-950/30 px-3 py-2 text-[11px] text-red-200">
                {robotListError}
              </p>
            )}

            <div className="mt-4 border-t border-[#2d2d34] pt-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                {t('robotsFromSystem')}
              </p>

              <div className="space-y-2">
                {backendRobots.length === 0 ? (
                  <p className="rounded border border-[#2d2d34] bg-[#0c0e16] px-3 py-3 text-center text-[11px] text-slate-500">
                    {t('noRobotsLoaded')}
                  </p>
                ) : (
                  backendRobots.map((robot) => {
                    const isSelected = selectedRobotId === robot.id
                    const robotRuntime = robotRuntimeById[robot.id]
                    const robotExecution = robotExecutionById[robot.id]
                    const robotFault = robotFaultsById[robot.id]
                    const commandFault =
                      robotFault?.active &&
                      (robotFault.kind === 'command' || robotFault.kind === 'timeout')
                        ? robotFault
                        : null
                    const commandFailure = commandFault
                      ? buildCommandFailurePresentation(
                          robotExecution?.lastError ||
                            robotRuntime?.lastError ||
                            commandFault.message
                        )
                      : null
                    const recoveryFeedback = commandRecoveryFeedback[robot.id]
                    const robotBadge = getRobotRuntimeBadge(robotRuntime)
                    const isConfiguredForConnection = simulatorConfig.robotId === robot.id
                    const robotSimulatorConfig = getRobotSimulatorConfig(robot)
                    const isRobotRuntimeActive = isBackendRobotRuntimeActive(robot)
                    const canConnectRobot = canConnectBackendRobot(robot)
                    const saveFeedback = sceneBindingSaveFeedback[robot.id]
                    const liveSceneBinding = getLiveRobotSceneBinding(robot)
                    const isSceneBindingDirty = !hasPersistedSceneBinding(robot, liveSceneBinding)
                    const robotCollisionPresentation = buildRobotCollisionPresentation(
                      robot.id,
                      backendRobots.map((item) => ({ id: item.id, name: item.robotName })),
                      robotContactsById,
                      robotFaultsById,
                      language
                    )

                    const visibleSaveFeedback =
                      isSceneBindingDirty && saveFeedback?.status === 'success'
                        ? undefined
                        : saveFeedback

                    const contact = robotContactsById[robot.id]
                    const isCollision = contact?.level === 'collision'
                    const isProximity = contact?.level === 'proximity'
                    const isFaultActive =
                      robotFaultsById[robot.id]?.active &&
                      (robotFaultsById[robot.id]?.kind === 'collision' ||
                        robotFaultsById[robot.id]?.code.startsWith('COLLISION_'))
                    const isLatchedFaultWaitingReset = isFaultActive && !contact

                    const cardBorderClass = isCollision
                      ? 'border-red-500 bg-red-950/15 shadow-[0_0_12px_rgba(239,68,68,0.15)] hover:border-red-400'
                      : isProximity
                        ? 'border-amber-500 bg-amber-950/15 shadow-[0_0_12px_rgba(245,158,11,0.15)] hover:border-amber-400'
                        : isLatchedFaultWaitingReset
                          ? 'border-rose-500/40 bg-rose-950/5 hover:border-rose-400/50'
                          : isSelected
                            ? 'border-blue-500/60 bg-blue-950/20 shadow-[0_0_12px_rgba(59,130,246,0.15)]'
                            : 'border-[#2d2d34] bg-[#0c0e16] hover:border-blue-500/35'

                    const proximityDetails = (() => {
                      if (!isProximity || !contact) return null
                      const counterpartNames = (contact.counterpartRobotIds ?? []).map((cid) => {
                        const found = backendRobots.find((r) => r.id === cid)
                        return found ? found.robotName : 'Robot'
                      })
                      const obstacleNames = contact.objectIds ?? []
                      const subjects = [...counterpartNames, ...obstacleNames].join(
                        language === 'vi' ? ' và ' : ' & '
                      )

                      if (language === 'vi') {
                        switch (contact.kind) {
                          case 'robot':
                            return `Quá gần robot ${subjects || 'khác'}`
                          case 'ground':
                            return 'Quá gần mặt phẳng an toàn của sàn'
                          case 'self':
                            return 'Các bộ phận robot đang ở quá gần nhau'
                          case 'obstacle':
                            return `Quá gần vật cản${subjects ? ` ${subjects}` : ''}`
                          default:
                            return 'Đã vào vùng cảnh báo an toàn'
                        }
                      }

                      switch (contact.kind) {
                        case 'robot':
                          return `Too close to ${subjects || 'another robot'}`
                        case 'ground':
                          return 'Too close to the ground safety plane'
                        case 'self':
                          return 'Robot links are too close to each other'
                        case 'obstacle':
                          return `Too close to obstacle${subjects ? ` ${subjects}` : ''}`
                        default:
                          return 'Inside a safety warning zone'
                      }
                    })()

                    return (
                      <div
                        key={robot.id}
                        ref={(element) => {
                          robotCardRefs.current[robot.id] = element
                        }}
                        onClick={() =>
                          handleSelectBackendRobot(robot, {
                            switchToConnection: false
                          })
                        }
                        className={`cursor-pointer rounded border p-3 transition ${cardBorderClass}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-bold text-white">
                              {robot.robotName}
                            </p>
                            <p className="mt-0.5 text-[10px] text-slate-500">{robot.model}</p>
                            <span
                              onClick={(event) => {
                                event.stopPropagation()
                                navigator.clipboard.writeText(robot.id)
                              }}
                              className="mt-1 font-mono text-[9px] text-slate-500 hover:text-blue-400 select-all cursor-pointer transition flex items-center gap-1"
                              title={t('clickToCopyCode')}
                            >
                              ID: {robot.id.slice(0, 8)}...
                            </span>
                            <div className="mt-2 flex flex-wrap items-center gap-1">
                              <span
                                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold ${robotBadge.color}`}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${robotBadge.dot}`} />
                                {robotBadge.label}
                              </span>

                              {isConfiguredForConnection && !isSelected && (
                                <span className="rounded border border-blue-500/30 bg-blue-950/20 px-1.5 py-0.5 text-[9px] font-bold text-blue-300">
                                  {t('configured')}
                                </span>
                              )}

                              {isCollision && (
                                <span className="inline-flex items-center gap-1 rounded bg-red-500/25 px-1.5 py-0.5 text-[9px] font-bold text-red-300 border border-red-500/30">
                                  {t('collisionWarning')}
                                </span>
                              )}
                              {isProximity && (
                                <span className="inline-flex items-center gap-1 rounded bg-amber-500/25 px-1.5 py-0.5 text-[9px] font-bold text-amber-300 border border-amber-500/30">
                                  {t('nearCollision')}
                                </span>
                              )}
                              {isLatchedFaultWaitingReset && (
                                <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-bold text-rose-300 border border-rose-500/20">
                                  {t('stoppedWaitingReset')}
                                </span>
                              )}

                              {homingStatuses[robot.id] === 'homing' && (
                                <span className="inline-flex items-center gap-1 rounded bg-amber-600/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-300 border border-amber-500/30 animate-pulse">
                                  {t('homing')}
                                </span>
                              )}
                              {homingStatuses[robot.id] === 'success' && (
                                <span className="inline-flex items-center gap-1 rounded bg-emerald-600/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300 border border-emerald-500/30">
                                  {t('homeSucceeded')}
                                </span>
                              )}
                              {homingStatuses[robot.id] === 'failed' && (
                                <span className="inline-flex items-center gap-1 rounded bg-red-600/20 px-1.5 py-0.5 text-[9px] font-bold text-red-300 border border-red-500/30">
                                  {t('homeFailed')}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="mt-2.5 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-slate-400">
                          <span>
                            {t('systemConnection')}: {robot.status}
                          </span>
                          <span>
                            {t('connectionType')}: {robot.connectionType}
                          </span>
                          <span className="truncate">
                            {t('lastHeartbeat')}: {formatRuntimeTime(robotRuntime?.lastHeartbeatAt)}
                          </span>
                          <span className="truncate">
                            {t('lastTelemetry')}: {formatRuntimeTime(robotRuntime?.lastTelemetryAt)}
                          </span>
                          <span
                            className={
                              robotExecution?.isPlaying
                                ? 'font-bold text-violet-300 col-span-2'
                                : 'text-slate-500 col-span-2'
                            }
                          >
                            {t('execution')}:{' '}
                            {robotExecution?.isPlaying
                              ? `${t('runningStep')} ${robotExecution.currentStepIndex + 1}`
                              : t('idle')}
                          </span>
                        </div>

                        {isCollision && robotCollisionPresentation && (
                          <div className="mt-2 flex gap-1.5 rounded border border-red-500/40 bg-red-950/25 px-2 py-1.5 text-[9px] text-red-200">
                            <AlertTriangle className="mt-0.5 shrink-0 text-red-400" size={12} />
                            <div className="min-w-0 flex-1">
                              <p className="font-bold truncate">
                                {robotCollisionPresentation.title}
                              </p>
                              <p className="text-[8px] text-red-200/80 mt-0.5 leading-relaxed">
                                {robotCollisionPresentation.detail}
                              </p>
                            </div>
                          </div>
                        )}

                        {isProximity && proximityDetails && (
                          <div className="mt-2 flex gap-1.5 rounded border border-amber-500/40 bg-amber-950/25 px-2 py-1.5 text-[9px] text-amber-200">
                            <AlertTriangle className="mt-0.5 shrink-0 text-amber-400" size={12} />
                            <span className="truncate flex-1">{proximityDetails}</span>
                          </div>
                        )}

                        {commandFailure && (
                          <div className="mt-2 rounded border border-red-500/40 bg-red-950/30 px-2.5 py-2 text-[9px] text-red-100">
                            <div className="flex items-start gap-1.5">
                              <AlertTriangle className="mt-0.5 shrink-0 text-red-400" size={13} />
                              <div className="min-w-0 flex-1">
                                <p className="font-bold text-red-200">{commandFailure.title}</p>
                                <p className="mt-0.5 leading-relaxed text-red-100/85">
                                  {commandFailure.detail}
                                </p>
                                <p className="mt-1 leading-relaxed text-amber-200/90">
                                  {commandFailure.suggestion}
                                </p>
                              </div>
                            </div>

                            <details className="mt-1.5 border-t border-red-500/20 pt-1.5">
                              <summary className="cursor-pointer select-none text-[8px] font-bold text-slate-400 hover:text-slate-200">
                                {t('technicalDetails')}
                              </summary>
                              <p className="mt-1 break-all font-mono text-[8px] leading-relaxed text-slate-400">
                                {commandFailure.technicalDetail}
                              </p>
                            </details>

                            <button
                              type="button"
                              disabled={recoveryFeedback?.status === 'working'}
                              onClick={(event) => {
                                event.stopPropagation()
                                void handleRecoverRobotCommand(robot.id)
                              }}
                              className="mt-2 flex w-full items-center justify-center gap-1 rounded border border-red-400/40 bg-red-500/15 px-2 py-1.5 text-[9px] font-bold text-red-100 transition hover:bg-red-500/25 disabled:cursor-wait disabled:opacity-50"
                            >
                              <RefreshCw
                                size={11}
                                className={
                                  recoveryFeedback?.status === 'working' ? 'animate-spin' : ''
                                }
                              />
                              {recoveryFeedback?.status === 'working'
                                ? t('recovering')
                                : t('recover')}
                            </button>

                            {recoveryFeedback && recoveryFeedback.status !== 'working' && (
                              <p
                                className={`mt-1.5 text-[8px] leading-relaxed ${
                                  recoveryFeedback.status === 'success'
                                    ? 'text-emerald-300'
                                    : 'text-red-300'
                                }`}
                              >
                                {recoveryFeedback.message}
                              </p>
                            )}
                          </div>
                        )}

                        {robotRuntime?.lastError &&
                          !commandFailure &&
                          !(
                            robotCollisionPresentation &&
                            isTechnicalCollisionError(robotRuntime.lastError)
                          ) && (
                            <p className="mt-2 rounded border border-red-500/30 bg-red-950/25 px-2 py-1 text-[9px] text-red-200">
                              {robotRuntime.lastError}
                            </p>
                          )}
                        {robotExecution?.lastError &&
                          !commandFailure &&
                          !(
                            robotCollisionPresentation &&
                            isTechnicalCollisionError(robotExecution.lastError)
                          ) && (
                            <p className="mt-2 rounded border border-red-500/30 bg-red-950/25 px-2 py-1 text-[9px] text-red-200">
                              Execution: {robotExecution.lastError}
                            </p>
                          )}

                        <div className="mt-3 grid grid-cols-3 gap-1 pt-2 border-t border-[#2d2d34]/60">
                          <button
                            type="button"
                            disabled={!backendToken}
                            onClick={(event) => {
                              event.stopPropagation()
                              handleSelectBackendRobot(robot, {
                                switchToConnection: false
                              })
                              openSingleFactoryProgram(robot.id)
                            }}
                            className="flex items-center justify-center gap-1 rounded bg-violet-600/15 border border-violet-500/30 py-1 text-[9px] font-bold text-violet-300 transition hover:bg-violet-600/30 hover:text-white disabled:opacity-45"
                            title={`${t('importRunLuaForRobot')} ${robot.robotName}`}
                          >
                            <FileCode2 size={10} />
                            LUA
                          </button>

                          {isRobotRuntimeActive ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                onSimulatorDisconnectRobot(robot.id)
                              }}
                              className="flex items-center justify-center rounded bg-amber-600/15 border border-amber-500/30 py-1 text-[9px] font-bold text-amber-300 transition hover:bg-amber-600/30 hover:text-white"
                              title={t('disconnectThisRobot')}
                            >
                              {t('disconnect')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                void onSimulatorConnectRobot(robotSimulatorConfig)
                              }}
                              disabled={!canConnectRobot}
                              className="flex items-center justify-center rounded bg-emerald-600/15 border border-emerald-500/30 py-1 text-[9px] font-bold text-emerald-300 transition hover:bg-emerald-600/30 hover:text-white disabled:opacity-45"
                              title={
                                canConnectRobot
                                  ? t('connectThisRobot')
                                  : t('enterConnectionKeyFirst')
                              }
                            >
                              {t('connect')}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleDeleteBackendRobot(robot)
                            }}
                            disabled={deletingRobotId === robot.id || isRobotRuntimeActive}
                            className="flex items-center justify-center gap-1 rounded bg-red-600/10 border border-red-500/30 py-1 text-[9px] font-bold text-red-300 transition hover:bg-red-600/25 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                            title={
                              isRobotRuntimeActive ? t('disconnectBeforeDelete') : t('deleteRobot')
                            }
                          >
                            <Trash2 size={10} />
                            {t('deleteRobot')}
                          </button>
                        </div>

                        {isSelected && workspaceMode === 'factory' && (
                          <div className="mt-3 rounded border border-[#2d2d34] bg-[#080a10] p-2">
                            {isRobotRuntimeActive && (
                              <p className="mb-2 rounded border border-amber-500/30 bg-amber-950/20 px-2 py-1 text-[10px] text-amber-200">
                                {language === 'vi'
                                  ? 'Robot đang trực tuyến. Hãy ngắt kết nối trước khi sửa vị trí.'
                                  : 'The robot is online. Disconnect it before editing its position.'}
                              </p>
                            )}
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                {t('scenePosition')}
                              </span>

                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleSaveSceneBinding(robot)
                                }}
                                disabled={
                                  isRobotRuntimeActive ||
                                  saveFeedback?.status === 'saving' ||
                                  !isSceneBindingDirty
                                }
                                className="rounded bg-blue-600 px-2 py-1 text-[10px] font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {saveFeedback?.status === 'saving'
                                  ? 'Đang lưu...'
                                  : isSceneBindingDirty
                                    ? 'Lưu vị trí'
                                    : 'Đã lưu'}
                              </button>

                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setSelectedJointName(null)
                                  setIKMode(false)
                                  setRobotPlacementMode(!isRobotPlacementMode)
                                }}
                                disabled={isRobotRuntimeActive}
                                className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                                  isRobotPlacementMode
                                    ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                                    : 'border border-[#343849] text-slate-300 hover:bg-[#242833] hover:text-white'
                                }`}
                              >
                                <Move3D size={11} />
                                Kéo thả
                              </button>
                            </div>

                            {isRobotPlacementMode && (
                              <div className="mb-2 grid grid-cols-2 gap-1 rounded-lg border border-[#2d2d34] bg-[#0c0e16] p-1">
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    setRobotPlacementTransformMode('translate')
                                  }}
                                  disabled={isRobotRuntimeActive}
                                  className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                                    robotPlacementTransformMode === 'translate'
                                      ? 'bg-emerald-600 text-white shadow'
                                      : 'text-slate-400 hover:bg-[#1a1d27] hover:text-white'
                                  }`}
                                >
                                  <Move3D size={12} />
                                  Di chuyển
                                </button>

                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    setRobotPlacementTransformMode('rotate')
                                  }}
                                  disabled={isRobotRuntimeActive}
                                  className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                                    robotPlacementTransformMode === 'rotate'
                                      ? 'bg-violet-600 text-white shadow'
                                      : 'text-slate-400 hover:bg-[#1a1d27] hover:text-white'
                                  }`}
                                >
                                  <RotateCw size={12} />
                                  Xoay hướng
                                </button>
                              </div>
                            )}

                            {isSceneBindingDirty && saveFeedback?.status !== 'saving' && (
                              <p className="mb-2 rounded border border-amber-500/40 bg-amber-950/25 px-2 py-1 text-[10px] text-amber-200">
                                Vị trí đã thay đổi và chưa được lưu.
                              </p>
                            )}

                            {visibleSaveFeedback && (
                              <p
                                className={`mb-2 rounded border px-2 py-1 text-[10px] ${
                                  visibleSaveFeedback.status === 'success'
                                    ? 'border-emerald-500/40 bg-emerald-950/25 text-emerald-200'
                                    : visibleSaveFeedback.status === 'error'
                                      ? 'border-red-500/40 bg-red-950/25 text-red-200'
                                      : 'border-blue-500/40 bg-blue-950/25 text-blue-200'
                                }`}
                              >
                                {visibleSaveFeedback.message}
                              </p>
                            )}

                            <div className="grid grid-cols-2 gap-2">
                              {(['baseX', 'baseY', 'baseZ', 'baseYaw'] as const).map((field) => {
                                const binding = getLiveRobotSceneBinding(robot)
                                const label =
                                  field === 'baseX'
                                    ? 'X (mm)'
                                    : field === 'baseY'
                                      ? 'Y (mm)'
                                      : field === 'baseZ'
                                        ? 'Z (mm)'
                                        : 'Yaw (deg)'

                                return (
                                  <label key={field} className="block">
                                    <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500">
                                      {label}
                                    </span>
                                    <input
                                      disabled={isRobotRuntimeActive}
                                      type="number"
                                      value={binding[field]}
                                      onChange={(event) =>
                                        handleSceneBindingNumberChange(
                                          robot,
                                          field,
                                          event.target.value
                                        )
                                      }
                                      className="mt-1 w-full rounded border border-[#343849] bg-[#0c0e16] px-2 py-1.5 text-[11px] text-white outline-none transition focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                                    />
                                  </label>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>

          <ScenePanel />

          <FactoryLuaProgramModal
            robots={backendRobots}
            backendUrl={simulatorConfig.backendUrl}
            token={backendToken}
            simulatorConfigByRobotId={simulatorConfigByRobotId}
          />

          <AddRobotWizard
            open={isAddRobotOpen}
            backendUrl={simulatorConfig.backendUrl}
            token={backendToken}
            companyId={addRobotCompanyId.trim()}
            onClose={() => setIsAddRobotOpen(false)}
            onCreated={(robot, deviceSecret) => {
              setBackendRobots((current) => [
                robot,
                ...current.filter((item) => item.id !== robot.id)
              ])

              handleSelectBackendRobot(robot, { deviceSecret })
            }}
          />
        </div>
      )}
    </div>
  )
}
