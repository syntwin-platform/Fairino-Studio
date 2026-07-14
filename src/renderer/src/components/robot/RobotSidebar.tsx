import {
  Cpu,
  FileCode2,
  HelpCircle,
  Home,
  Move3D,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  Server,
  Square,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import FactoryLuaProgramModal from '../factory/FactoryLuaProgramModal'
import { useFactoryProgramStore } from '../../store/factoryProgramStore'
import { translations } from '../../i18n/translations'
import { useRobotStore } from '../../store/robotStore'
import { useSceneStore } from '../../store/sceneStore'
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
import ScenePanel from '../scene/ScenePanel'
import BackendSimulatorPanel from '../BackendSimulatorPanel'
import AddRobotWizard from './AddRobotWizard'
import {
  deleteRobot,
  listRobots,
  updateRobotSceneBinding as updateBackendRobotSceneBinding,
  type BackendRobot
} from '../../services/backendRobotClient'
import {
  BackendSimulatorConfig,
  BackendSimulatorConfigByRobotId,
  BackendSimulatorStatus
} from '../../types/backendDevice'

interface InfoTooltipProps {
  text: string
}

interface SceneBindingSaveFeedback {
  status: 'saving' | 'success' | 'error'
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

const TOKEN_KEY = 'syntwin.backendProgram.accessToken'
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
  onSimulatorConnectRobot,
  onSimulatorDisconnectRobot
}: RobotSidebarProps): ReactElement {
  const [activeTab, setActiveTab] = useState<'robot' | 'connection' | 'scene'>('robot')
  const [isHoming, setIsHoming] = useState(false)
  const [isAddRobotOpen, setIsAddRobotOpen] = useState(false)
  const [addRobotCompanyId, setAddRobotCompanyId] = useState(
    () => window.localStorage.getItem(ADD_ROBOT_COMPANY_KEY) || ''
  )

  const [backendRobots, setBackendRobots] = useState<BackendRobot[]>([])
  const [robotListLoading, setRobotListLoading] = useState(false)
  const [robotListError, setRobotListError] = useState('')
  const [deletingRobotId, setDeletingRobotId] = useState('')
  const [factoryActionBusy, setFactoryActionBusy] = useState(false)
  const openSingleFactoryProgram = useFactoryProgramStore((state) => state.openSingle)
  const openBatchFactoryProgram = useFactoryProgramStore((state) => state.openBatch)
  const [sceneBindingSaveFeedback, setSceneBindingSaveFeedback] = useState<
    Record<string, SceneBindingSaveFeedback>
  >({})
  const homeRunIdRef = useRef(0)
  const robotListAutoLoadKeyRef = useRef('')
  const robotCardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const jointAngles = useRobotStore((state) => state.jointAngles)
  const setJointAngles = useRobotStore((state) => state.setJointAngles)
  const setPlaying = useRobotStore((state) => state.setPlaying)
  const isPlaying = useRobotStore((state) => {
    const robotId = state.selectedRobotId

    return robotId ? (state.robotExecutionById[robotId]?.isPlaying ?? false) : state.isPlaying
  })
  const setCurrentStepIndex = useRobotStore((state) => state.setCurrentStepIndex)
  const setSelectedStepId = useRobotStore((state) => state.setSelectedStepId)
  const tcpPose = useRobotStore((state) => state.tcpPose)
  const isIKMode = useRobotStore((state) => state.isIKMode)
  const isRobotPlacementMode = useRobotStore((state) => state.isRobotPlacementMode)
  const setRobotPlacementMode = useRobotStore((state) => state.setRobotPlacementMode)
  const robotPlacementTransformMode = useRobotStore((state) => state.robotPlacementTransformMode)
  const setRobotPlacementTransformMode = useRobotStore(
    (state) => state.setRobotPlacementTransformMode
  )
  const setIKMode = useRobotStore((state) => state.setIKMode)
  const selectedJointName = useRobotStore((state) => state.selectedJointName)
  const setSelectedJointName = useRobotStore((state) => state.setSelectedJointName)

  const lengthUnit = useRobotStore((state) => state.lengthUnit)
  const setLengthUnit = useRobotStore((state) => state.setLengthUnit)
  const angleUnit = useRobotStore((state) => state.angleUnit)
  const setAngleUnit = useRobotStore((state) => state.setAngleUnit)

  const isDebugHitbox = useSceneStore((state) => state.isDebugHitbox)
  const setDebugHitbox = useSceneStore((state) => state.setDebugHitbox)
  const setCollisionWarning = useSceneStore((state) => state.setCollisionWarning)

  const language = useRobotStore((state) => state.language)
  const t = (key: keyof typeof translations.vi): string => translations[language][key]
  const backendToken = window.sessionStorage.getItem(TOKEN_KEY) || ''
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

  const getRobotSimulatorConfig = (
    robot: BackendRobot,
    options?: {
      deviceSecret?: string
    }
  ): BackendSimulatorConfig => {
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

  const canConnectBackendRobot = (robot: BackendRobot): boolean => {
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

  const isBackendRobotRuntimeActive = (robot: BackendRobot): boolean => {
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

  const loadBackendRobots = async (): Promise<void> => {
    if (!backendToken) {
      setRobotListError('Hãy đăng nhập Backend trước.')
      return
    }

    if (!simulatorConfig.backendUrl.trim()) {
      setRobotListError('Backend URL đang trống.')
      return
    }

    if (!addRobotCompanyId.trim()) {
      setRobotListError('Company ID đang trống.')
      return
    }

    setRobotListLoading(true)
    setRobotListError('')

    try {
      const robots = await listRobots(
        simulatorConfig.backendUrl,
        backendToken,
        addRobotCompanyId.trim()
      )

      setBackendRobots(robots)
      setRobots(robots.map(toRobotInstance))

      if (simulatorConfig.robotId && robots.some((robot) => robot.id === simulatorConfig.robotId)) {
        selectRobot(simulatorConfig.robotId)
      } else if (!simulatorConfig.robotId && robots.length > 0) {
        selectRobot(robots[0].id)
      }
    } catch (error) {
      setRobotListError(error instanceof Error ? error.message : 'Không tải được danh sách robot.')
    } finally {
      setRobotListLoading(false)
    }
  }

  useEffect(() => {
    if (!backendToken || !simulatorConfig.backendUrl.trim() || !addRobotCompanyId.trim()) {
      return
    }

    const autoLoadKey = `${simulatorConfig.backendUrl}|${addRobotCompanyId.trim()}|${backendToken.slice(0, 12)}`

    if (robotListAutoLoadKeyRef.current === autoLoadKey) {
      return
    }

    robotListAutoLoadKeyRef.current = autoLoadKey
    void loadBackendRobots()
  }, [backendToken, simulatorConfig.backendUrl, addRobotCompanyId])

  const handleJointChange = (idx: number, val: number): void => {
    const updated = [...jointAngles] as JointAngles
    updated[idx] = Math.round(val * 10) / 10
    setJointAngles(updated)
  }

  const handleConnectReadyRobots = async (): Promise<void> => {
    const readyRobots = backendRobots.filter((robot) => canConnectBackendRobot(robot))

    if (readyRobots.length === 0) {
      setRobotListError('Không có robot nào đủ Backend URL + Robot ID + Device Secret để connect.')
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
      setRobotListError('Không có robot nào đang online/running để disconnect.')
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
      setRobotListError('Hãy đăng nhập Backend trước khi xóa robot.')
      return
    }

    if (!simulatorConfig.backendUrl.trim()) {
      setRobotListError('Backend URL đang trống.')
      return
    }

    if (isBackendRobotRuntimeActive(robot)) {
      setRobotListError('Không thể xóa robot đang online/running. Hãy Disconnect robot trước.')
      return
    }

    const confirmed = window.confirm(
      `Xóa robot "${robot.robotName}" khỏi danh sách sử dụng?\n\nRobot sẽ bị disable trong backend.`
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
      setRobotListError(error instanceof Error ? error.message : 'Không xóa được robot.')
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
        'Không thể sửa vị trí robot khi robot đang online/running. Hãy Disconnect trước.'
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
      const message = 'Disconnect robot trước khi lưu vị trí.'

      setRobotListError(message)
      setFeedback('error', message)
      return
    }

    if (!backendToken) {
      const message = 'Hãy đăng nhập Backend trước khi lưu vị trí.'
      setRobotListError(message)
      setFeedback('error', message)
      return
    }

    if (!simulatorConfig.backendUrl.trim()) {
      const message = 'Backend URL đang trống.'
      setRobotListError(message)
      setFeedback('error', message)
      return
    }

    const expectedBinding = getLiveRobotSceneBinding(robot)
    setFeedback('saving', 'Đang lưu vị trí vào Backend...')

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
        throw new Error('Backend chưa trả lại đúng vị trí vừa lưu.')
      }

      setBackendRobots((current) =>
        current.map((item) => (item.id === persistedRobot.id ? persistedRobot : item))
      )

      upsertRobot(toRobotInstance(persistedRobot))
      selectRobot(persistedRobot.id)

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
        setCollisionWarning(false)
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
    setCollisionWarning(false)
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

  return (
    <div className="flex h-full w-80 shrink-0 select-none flex-col border-r border-[#2d2d34] bg-[#1b1b1f] text-slate-200">
      <div className="border-b border-[#2d2d34] p-4 bg-[#141417]/20">
        <div className="flex items-center justify-between">
          <h2
            className="truncate text-sm font-bold leading-tight text-white"
            title={sidebarRobotName}
          >
            {sidebarRobotName}
          </h2>
          <div
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold ${statusBadgeColor}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
            <span>{statusBadgeLabel}</span>
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
                  Danh sách thiết bị
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Tạo robot backend thật rồi bind vào simulator config hiện tại.
                </p>
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
                    ? 'Hãy đăng nhập Backend trước'
                    : !addRobotCompanyId.trim()
                      ? 'Nhập Company ID trước'
                      : 'Thêm robot'
                }
              >
                <Plus size={13} />
                Add Robot
              </button>
            </div>

            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Company ID
              </span>
              <input
                value={addRobotCompanyId}
                onChange={(event) => handleAddRobotCompanyIdChange(event.target.value)}
                className="mt-1 w-full rounded-md border border-[#2d2d34] bg-[#0c0e16] px-3 py-2 text-xs text-white outline-none transition focus:border-blue-500"
                placeholder="Copy company id từ GET /api/companies"
              />
            </label>

            {!backendToken && (
              <p className="mt-2 rounded border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
                Hãy đăng nhập Backend ở panel bên phải trước khi Add Robot.
              </p>
            )}

            <div className="mt-3 border-t border-[#2d2d34] pt-3">
              <button
                type="button"
                disabled={backendRobots.length === 0 || !backendToken || factoryActionBusy}
                onClick={() => openBatchFactoryProgram(backendRobots.map((robot) => robot.id))}
                className="mb-3 flex w-full items-center justify-center gap-2 rounded bg-violet-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FileCode2 size={14} />
                Import LUA & Run Factory
              </button>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Robots từ Backend
                </span>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void handleConnectReadyRobots()}
                    disabled={
                      factoryActionBusy ||
                      backendRobots.every((robot) => !canConnectBackendRobot(robot))
                    }
                    className="rounded border border-emerald-500/40 px-2 py-1 text-[10px] font-semibold text-emerald-200 transition hover:bg-emerald-950/40 disabled:cursor-not-allowed disabled:opacity-40"
                    title="Connect tất cả robot đã có Device Secret"
                  >
                    Connect Ready
                  </button>

                  <button
                    type="button"
                    onClick={handleStopAllRobotMotion}
                    disabled={factoryRuntimeSummary.running === 0}
                    className="flex items-center gap-1 rounded border border-red-500/50 bg-red-950/20 px-2 py-1 text-[10px] font-bold text-red-300 transition hover:bg-red-950/50 disabled:cursor-not-allowed disabled:opacity-40"
                    title="Dừng toàn bộ workflow và backend command đang chạy"
                  >
                    <Square size={10} />
                    Stop All
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleDisconnectOnlineRobots()}
                    disabled={
                      factoryActionBusy ||
                      backendRobots.every((robot) => !isBackendRobotRuntimeActive(robot))
                    }
                    className="rounded border border-amber-500/40 px-2 py-1 text-[10px] font-semibold text-amber-200 transition hover:bg-amber-950/40 disabled:cursor-not-allowed disabled:opacity-40"
                    title="Disconnect tất cả robot đang online/running"
                  >
                    Disconnect Online
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
                    className="flex items-center gap-1 rounded border border-[#343849] px-2 py-1 text-[10px] font-semibold text-slate-300 transition hover:bg-[#242833] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RefreshCw size={11} className={robotListLoading ? 'animate-spin' : ''} />
                    Refresh
                  </button>
                </div>
              </div>

              {backendRobots.length > 0 && (
                <div className="mb-2 grid grid-cols-3 gap-1 rounded border border-[#2d2d34] bg-[#080a10] p-2">
                  <div className="col-span-3 flex items-center justify-between rounded border border-violet-500/30 bg-violet-950/20 px-3 py-2">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-violet-300">
                      Running Robots
                    </p>

                    <p className="text-base font-bold text-violet-200">
                      {factoryRuntimeSummary.running}
                    </p>
                  </div>
                  <div className="rounded bg-[#111827] px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
                      Total
                    </p>
                    <p className="text-sm font-bold text-white">{factoryRuntimeSummary.total}</p>
                  </div>

                  <div className="rounded bg-emerald-950/20 px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-emerald-500">
                      Online
                    </p>
                    <p className="text-sm font-bold text-emerald-300">
                      {factoryRuntimeSummary.online}
                    </p>
                  </div>

                  <div className="rounded bg-blue-950/20 px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-blue-400">
                      Ready
                    </p>
                    <p className="text-sm font-bold text-blue-300">{factoryRuntimeSummary.ready}</p>
                  </div>

                  <div className="rounded bg-amber-950/20 px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-amber-400">
                      Connecting
                    </p>
                    <p className="text-sm font-bold text-amber-300">
                      {factoryRuntimeSummary.connecting}
                    </p>
                  </div>

                  <div className="rounded bg-red-950/20 px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-red-400">
                      Error
                    </p>
                    <p className="text-sm font-bold text-red-300">{factoryRuntimeSummary.error}</p>
                  </div>

                  <div className="rounded bg-slate-900 px-2 py-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
                      Offline
                    </p>
                    <p className="text-sm font-bold text-slate-300">
                      {factoryRuntimeSummary.offline}
                    </p>
                  </div>
                </div>
              )}

              {robotListError && (
                <p className="mb-2 rounded border border-red-500/40 bg-red-950/30 px-3 py-2 text-[11px] text-red-200">
                  {robotListError}
                </p>
              )}

              <div className="space-y-2">
                {backendRobots.length === 0 ? (
                  <p className="rounded border border-[#2d2d34] bg-[#0c0e16] px-3 py-3 text-center text-[11px] text-slate-500">
                    Chưa có robot nào được load.
                  </p>
                ) : (
                  backendRobots.map((robot) => {
                    const isSelected = selectedRobotId === robot.id
                    const robotRuntime = robotRuntimeById[robot.id]
                    const robotExecution = robotExecutionById[robot.id]
                    const robotBadge = getRobotRuntimeBadge(robotRuntime)
                    const isConfiguredForConnection = simulatorConfig.robotId === robot.id
                    const robotSimulatorConfig = getRobotSimulatorConfig(robot)
                    const isRobotRuntimeActive = isBackendRobotRuntimeActive(robot)
                    const canConnectRobot = canConnectBackendRobot(robot)
                    const saveFeedback = sceneBindingSaveFeedback[robot.id]
                    const liveSceneBinding = getLiveRobotSceneBinding(robot)
                    const isSceneBindingDirty = !hasPersistedSceneBinding(robot, liveSceneBinding)

                    const visibleSaveFeedback =
                      isSceneBindingDirty && saveFeedback?.status === 'success'
                        ? undefined
                        : saveFeedback

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
                        className={`cursor-pointer rounded border p-3 transition ${
                          isSelected
                            ? 'border-blue-500/60 bg-blue-950/20'
                            : 'border-[#2d2d34] bg-[#0c0e16] hover:border-blue-500/35'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-bold text-white">
                              {robot.robotName}
                            </p>
                            <p className="mt-0.5 text-[10px] text-slate-500">{robot.model}</p>
                            <p className="mt-1 break-all font-mono text-[9px] text-slate-500">
                              {robot.id}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-1">
                              <span
                                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold ${robotBadge.color}`}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${robotBadge.dot}`} />
                                {robotBadge.label}
                              </span>

                              {isConfiguredForConnection && !isSelected && (
                                <span className="rounded border border-blue-500/30 bg-blue-950/20 px-1.5 py-0.5 text-[9px] font-bold text-blue-300">
                                  CONFIG
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
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
                              className="flex items-center gap-1 rounded border border-violet-500/40 px-2 py-1 text-[10px] font-bold text-violet-200 transition hover:bg-violet-950/40 disabled:opacity-40"
                              title={`Import và chạy LUA cho ${robot.robotName}`}
                            >
                              <FileCode2 size={11} />
                              LUA
                            </button>

                            {isRobotRuntimeActive ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  onSimulatorDisconnectRobot(robot.id)
                                }}
                                className="rounded border border-amber-500/40 px-2 py-1 text-[10px] font-bold text-amber-200 transition hover:bg-amber-950/40"
                                title="Disconnect robot này"
                              >
                                Disconnect
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void onSimulatorConnectRobot(robotSimulatorConfig)
                                }}
                                disabled={!canConnectRobot}
                                className="rounded border border-emerald-500/40 px-2 py-1 text-[10px] font-bold text-emerald-200 transition hover:bg-emerald-950/40 disabled:cursor-not-allowed disabled:opacity-40"
                                title={
                                  canConnectRobot
                                    ? 'Connect robot này'
                                    : 'Nhập Device Secret trong tab Connection trước'
                                }
                              >
                                Connect
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                void handleDeleteBackendRobot(robot)
                              }}
                              disabled={deletingRobotId === robot.id || isRobotRuntimeActive}
                              className="rounded border border-red-500/40 p-1.5 text-red-300 transition hover:bg-red-950/40 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                              title={
                                isRobotRuntimeActive
                                  ? 'Disconnect robot trước khi xóa'
                                  : 'Xóa robot'
                              }
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-slate-400">
                          <span>BE Status: {robot.status}</span>
                          <span>Mode: {robot.connectionType}</span>
                          <span>Heartbeat: {formatRuntimeTime(robotRuntime?.lastHeartbeatAt)}</span>
                          <span>Telemetry: {formatRuntimeTime(robotRuntime?.lastTelemetryAt)}</span>
                          <span
                            className={
                              robotExecution?.isPlaying
                                ? 'font-bold text-violet-300'
                                : 'text-slate-500'
                            }
                          >
                            Execution:{' '}
                            {robotExecution?.isPlaying
                              ? `Running step ${robotExecution.currentStepIndex + 1}`
                              : 'Idle'}
                          </span>
                        </div>

                        {robotRuntime?.lastError && (
                          <p className="mt-2 rounded border border-red-500/30 bg-red-950/25 px-2 py-1 text-[10px] text-red-200">
                            {robotRuntime.lastError}
                          </p>
                        )}
                        {robotExecution?.lastError && (
                          <p className="mt-2 rounded border border-red-500/30 bg-red-950/25 px-2 py-1 text-[10px] text-red-200">
                            Execution: {robotExecution.lastError}
                          </p>
                        )}
                        {isSelected && workspaceMode === 'factory' && (
                          <div className="mt-3 rounded border border-[#2d2d34] bg-[#080a10] p-2">
                            {isRobotRuntimeActive && (
                              <p className="mb-2 rounded border border-amber-500/30 bg-amber-950/20 px-2 py-1 text-[10px] text-amber-200">
                                Robot đang online/running. Disconnect trước khi sửa vị trí trong
                                scene.
                              </p>
                            )}
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                Vị trí trong scene
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
