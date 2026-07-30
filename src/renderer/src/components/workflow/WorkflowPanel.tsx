import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { useRobotStore } from '../../store/robotStore'
import { selectCollisionWarning, useSceneStore } from '../../store/sceneStore'
import type { JointAngles, WorkflowStep } from '../../types/robot.types'
import {
  ArrowDown,
  ArrowUp,
  Code2,
  FileCode2,
  Clock,
  HelpCircle,
  Lock,
  Pause,
  Play,
  Plus,
  Sparkles,
  Unlock,
  Square,
  Trash2,
  Settings
} from 'lucide-react'
import BlockWorkspace from './BlockWorkspace'
import { translations } from '../../i18n/translations'
import {
  getRobotRuntimeConfig,
  runMoveL,
  runMoveLForRobot
} from '../../services/robotMotionRuntime'
import ProgramImportPanel from './ProgramImportPanel'
import WorkflowStepDetailsModal from './WorkflowStepDetailsModal'
import { isAuthoritativeRecordedTraceStep } from '../../services/cartesianTraceRecorder'

const DEFAULT_SPEED = 30
const DEFAULT_ACC = 30
const DEFAULT_WAIT_MS = 500

interface InfoTooltipProps {
  text: string
}

interface WorkflowDisplayRow {
  key: string
  steps: WorkflowStep[]
  startIndex: number
  endIndex: number
  traceGroupId?: string
}

function buildWorkflowDisplayRows(steps: WorkflowStep[]): WorkflowDisplayRow[] {
  const rows: WorkflowDisplayRow[] = []
  let index = 0

  while (index < steps.length) {
    const first = steps[index]
    const groupId = first.trace?.groupId

    if (!groupId) {
      rows.push({ key: first.id, steps: [first], startIndex: index, endIndex: index })
      index += 1
      continue
    }

    const startIndex = index
    const groupedSteps: WorkflowStep[] = []
    while (index < steps.length && steps[index].trace?.groupId === groupId) {
      groupedSteps.push(steps[index])
      index += 1
    }

    rows.push({
      key: `trace:${groupId}`,
      steps: groupedSteps,
      startIndex,
      endIndex: index - 1,
      traceGroupId: groupId
    })
  }

  return rows
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
export default function WorkflowPanel(): ReactElement {
  const steps = useRobotStore((state) => state.steps)
  const addStep = useRobotStore((state) => state.addStep)
  const removeStep = useRobotStore((state) => state.removeStep)
  const clearSteps = useRobotStore((state) => state.clearSteps)
  const reorderSteps = useRobotStore((state) => state.reorderSteps)
  const selectedStepId = useRobotStore((state) => state.selectedStepId)
  const setSelectedStepId = useRobotStore((state) => state.setSelectedStepId)
  const setJointAngles = useRobotStore((state) => state.setJointAngles)
  const setJointAnglesForRobot = useRobotStore((state) => state.setJointAnglesForRobot)
  const updateStep = useRobotStore((state) => state.updateStep)
  const [editingStepId, setEditingStepId] = useState<string | null>(null)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  // Mode state
  const mode = useRobotStore((state) => state.mode)
  const setMode = useRobotStore((state) => state.setMode)
  const angleUnit = useRobotStore((state) => state.angleUnit)
  const lengthUnit = useRobotStore((state) => state.lengthUnit)
  const editingStep = editingStepId
    ? (steps.find((step) => step.id === editingStepId) ?? null)
    : null

  // Language translation helper
  const language = useRobotStore((state) => state.language)
  const t = (key: keyof typeof translations.vi): string => translations[language][key]

  // Simulation states
  const selectedRobotId = useRobotStore((state) => state.selectedRobotId)
  const robotExecutionById = useRobotStore((state) => state.robotExecutionById)
  const legacyIsPlaying = useRobotStore((state) => state.isPlaying)
  const legacyCurrentStepIndex = useRobotStore((state) => state.currentStepIndex)

  const selectedExecution = selectedRobotId ? robotExecutionById[selectedRobotId] : undefined

  const isPlaying = selectedRobotId ? (selectedExecution?.isPlaying ?? false) : legacyIsPlaying

  const currentStepIndex = selectedRobotId
    ? (selectedExecution?.currentStepIndex ?? 0)
    : legacyCurrentStepIndex
  const displayRows = useMemo(() => buildWorkflowDisplayRows(steps), [steps])
  const stepCardRefs = useRef(new Map<string, HTMLDivElement>())
  const activeDisplayRowKey = useMemo(
    () =>
      displayRows.find(
        (row) => currentStepIndex >= row.startIndex && currentStepIndex <= row.endIndex
      )?.key,
    [currentStepIndex, displayRows]
  )

  useEffect(() => {
    if (!isPlaying || !activeDisplayRowKey) return
    stepCardRefs.current
      .get(activeDisplayRowKey)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeDisplayRowKey, isPlaying])
  const collisionWarning = useSceneStore(selectCollisionWarning)
  const isRecordBlocked = isPlaying || collisionWarning
  const moveLPreviewAbortRef = useRef<AbortController | null>(null)
  const isRunActive = (): boolean => {
    const state = useRobotStore.getState()

    if (!selectedRobotId) {
      return state.isPlaying
    }

    return state.robotExecutionById[selectedRobotId]?.isPlaying ?? false
  }

  const setRunPlaying = (playing: boolean): void => {
    const state = useRobotStore.getState()

    if (!selectedRobotId) {
      state.setPlaying(playing)
      return
    }

    state.setRobotExecution(selectedRobotId, {
      isPlaying: playing,
      ...(playing ? { startedAt: new Date().toISOString() } : {})
    })

    const hasRunningRobot = Object.values(useRobotStore.getState().robotExecutionById).some(
      (execution) => execution.isPlaying
    )

    useRobotStore.getState().setPlaying(hasRunningRobot)
  }

  const setRunStepIndex = (index: number): void => {
    const state = useRobotStore.getState()

    if (!selectedRobotId) {
      state.setCurrentStepIndex(index)
      return
    }

    state.setRobotExecution(selectedRobotId, {
      currentStepIndex: index
    })

    if (state.selectedRobotId === selectedRobotId) {
      state.setCurrentStepIndex(index)
    }
  }

  const getRunJointAngles = (): JointAngles => {
    const state = useRobotStore.getState()

    if (!selectedRobotId) {
      return state.jointAngles
    }

    return state.jointAnglesByRobotId[selectedRobotId] ?? state.jointAngles
  }

  const setRunJointAngles = (angles: JointAngles): void => {
    if (selectedRobotId) {
      setJointAnglesForRobot(selectedRobotId, angles)
      return
    }

    setJointAngles(angles)
  }
  const handleRecordWaypoint = (type: 'MoveJ' | 'MoveL'): void => {
    if (isRecordBlocked) return

    const state = useRobotStore.getState()
    const pointNum = steps.filter((s) => s.type === 'MoveJ' || s.type === 'MoveL').length + 1

    addStep({
      type,
      label: `${type} - Waypoint ${pointNum}`,
      jointAngles: [...state.jointAngles],
      tcpPose: { ...state.tcpPose },
      speed: DEFAULT_SPEED,
      acc: DEFAULT_ACC
    })
  }

  const handleRecordWait = (): void => {
    if (isRecordBlocked) return

    addStep({
      type: 'WaitMs',
      label: `Wait - ${DEFAULT_WAIT_MS} ms`,
      delayMs: DEFAULT_WAIT_MS,
      speed: DEFAULT_SPEED,
      acc: DEFAULT_ACC
    })
  }

  const handleRecordGripperOpen = (): void => {
    if (isRecordBlocked) return

    addStep({
      type: 'GripperOpen',
      label: 'Gripper Open',
      speed: DEFAULT_SPEED,
      acc: DEFAULT_ACC
    })
  }

  const handleRecordGripperClose = (): void => {
    if (isRecordBlocked) return

    addStep({
      type: 'GripperClose',
      label: 'Gripper Close',
      speed: DEFAULT_SPEED,
      acc: DEFAULT_ACC
    })
  }

  const handleAddDO = (): void => {
    addStep({
      type: 'SetDO',
      label: language === 'vi' ? 'Cài đặt DO 1' : 'Set DO 1',
      speed: 0,
      acc: 0,
      doIndex: 1,
      doValue: 1,
      doType: 'cabinet'
    })
  }

  const previewMoveLStep = async (step: WorkflowStep): Promise<void> => {
    if (!step.tcpPose) {
      console.warn(`${step.label}: missing tcpPose for MoveL preview`)
      return
    }

    moveLPreviewAbortRef.current?.abort()

    const controller = new AbortController()
    moveLPreviewAbortRef.current = controller

    try {
      if (selectedRobotId) {
        await runMoveLForRobot(selectedRobotId, step.tcpPose, step.speed, controller.signal, {
          managePlayingState: false
        })
      } else {
        await runMoveL(step.tcpPose, step.speed, controller.signal, { managePlayingState: false })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('MoveL preview failed:', error)
      }
    } finally {
      if (moveLPreviewAbortRef.current === controller) {
        moveLPreviewAbortRef.current = null
      }
    }
  }

  const handleStepClick = (step: WorkflowStep): void => {
    setSelectedStepId(step.id)

    moveLPreviewAbortRef.current?.abort()
    moveLPreviewAbortRef.current = null

    if (isAuthoritativeRecordedTraceStep(step)) {
      // Preview the exact trained joint branch instead of asking MoveL IK to choose again.
      setRunJointAngles(step.jointAngles)
      return
    }

    if (step.type === 'MoveL') {
      void previewMoveLStep(step)
      return
    }

    if (step.jointAngles) {
      setRunJointAngles(step.jointAngles)
    }
  }
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value))

  const getMotionDurationMs = (
    startAngles: number[],
    targetAngles: number[],
    speed: number
  ): number => {
    const speedPercent = clamp(speed, 1, 100)
    const maxDelta = Math.max(
      ...targetAngles.map((target, index) => Math.abs(target - startAngles[index]))
    )

    return clamp(300 + maxDelta * 10 * (30 / speedPercent), 250, 6000)
  }

  const wait = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds))

  const animateJointMotion = async (
    targetAngles: NonNullable<WorkflowStep['jointAngles']>,
    speed: number
  ): Promise<void> => {
    const startAngles = [...getRunJointAngles()]
    const duration = Math.max(
      1,
      getMotionDurationMs(startAngles, targetAngles, speed) / useRobotStore.getState().playbackSpeed
    )

    await new Promise<void>((resolve) => {
      const startedAtMs = performance.now()

      const renderFrame = (nowMs: number): void => {
        if (!isRunActive()) {
          resolve()
          return
        }

        const progress = Math.min(1, Math.max(0, (nowMs - startedAtMs) / duration))
        // Smoothstep avoids a visible snap when playback starts from HOME or an arbitrary pose.
        const easedProgress = progress * progress * (3 - 2 * progress)
        const interpolated = startAngles.map(
          (start, index) => start + (targetAngles[index] - start) * easedProgress
        ) as JointAngles

        setRunJointAngles(interpolated)
        if (progress >= 1) {
          setRunJointAngles(targetAngles)
          resolve()
          return
        }

        window.requestAnimationFrame(renderFrame)
      }

      window.requestAnimationFrame(renderFrame)
    })
  }

  const animateRecordedTraceGroup = async (
    traceSteps: Array<WorkflowStep & { jointAngles: NonNullable<WorkflowStep['jointAngles']> }>,
    firstWorkflowIndex: number,
    expectedStartAngles?: JointAngles
  ): Promise<void> => {
    if (traceSteps.length === 0) return

    const currentStartAngles = getRunJointAngles()
    if (
      expectedStartAngles &&
      Math.max(
        ...expectedStartAngles.map((angle, index) => Math.abs(angle - currentStartAngles[index]))
      ) > 0.25
    ) {
      await animateJointMotion(expectedStartAngles, traceSteps[0].speed)
      if (!isRunActive()) return
    }

    const startAngles = [...(expectedStartAngles ?? getRunJointAngles())]
    const playbackSpeed = Math.max(0.1, useRobotStore.getState().playbackSpeed)
    const segmentEndsMs: number[] = []
    let totalRecordedMs = 0

    for (const step of traceSteps) {
      totalRecordedMs += Math.max(0, step.trace?.segmentDurationMs ?? 0)
      segmentEndsMs.push(totalRecordedMs)
    }

    totalRecordedMs = Math.max(1, totalRecordedMs)

    await new Promise<void>((resolve) => {
      const startedAtMs = performance.now()
      let lastAppliedAtMs = startedAtMs
      let activeSegmentIndex = -1
      setSelectedStepId(traceSteps[0].id)
      setRunStepIndex(firstWorkflowIndex)

      const renderFrame = (nowMs: number): void => {
        if (!isRunActive()) {
          resolve()
          return
        }

        const recordedElapsedMs = Math.min(totalRecordedMs, (nowMs - startedAtMs) * playbackSpeed)
        let segmentIndex = 0
        while (
          segmentIndex < segmentEndsMs.length - 1 &&
          recordedElapsedMs >= segmentEndsMs[segmentIndex]
        ) {
          segmentIndex += 1
        }

        const step = traceSteps[segmentIndex]
        if (segmentIndex !== activeSegmentIndex) {
          activeSegmentIndex = segmentIndex
          setSelectedStepId(step.id)
          setRunStepIndex(firstWorkflowIndex + segmentIndex)
        }
        const segmentStartMs = segmentIndex === 0 ? 0 : segmentEndsMs[segmentIndex - 1]
        const segmentDurationMs = Math.max(1, segmentEndsMs[segmentIndex] - segmentStartMs)
        const progress = Math.min(
          1,
          Math.max(0, (recordedElapsedMs - segmentStartMs) / segmentDurationMs)
        )
        const segmentStartAngles =
          segmentIndex === 0 ? startAngles : traceSteps[segmentIndex - 1].jointAngles
        const interpolated = segmentStartAngles.map(
          (start, index) => start + (step.jointAngles[index] - start) * progress
        ) as NonNullable<WorkflowStep['jointAngles']>

        if (recordedElapsedMs >= totalRecordedMs) {
          const lastStep = traceSteps.at(-1)!
          setRunJointAngles(lastStep.jointAngles)
          setSelectedStepId(lastStep.id)
          setRunStepIndex(firstWorkflowIndex + traceSteps.length - 1)
          resolve()
          return
        }

        if (nowMs - lastAppliedAtMs >= 33) {
          lastAppliedAtMs = nowMs
          setRunJointAngles(interpolated)
        }

        window.requestAnimationFrame(renderFrame)
      }

      window.requestAnimationFrame(renderFrame)
    })
  }

  const runMoveLStep = async (step: WorkflowStep): Promise<void> => {
    if (!step.tcpPose) {
      console.warn(`${step.label}: missing tcpPose for MoveL`)
      return
    }

    // Capture robot ID so switching selection cannot redirect this command.
    const runRobotId = selectedRobotId
    const controller = new AbortController()

    const unsubscribe = useRobotStore.subscribe((state) => {
      const runIsActive = runRobotId
        ? (state.robotExecutionById[runRobotId]?.isPlaying ?? false)
        : state.isPlaying

      if (!runIsActive) {
        controller.abort()
      }
    })

    try {
      if (runRobotId) {
        await runMoveLForRobot(runRobotId, step.tcpPose, step.speed, controller.signal, {
          managePlayingState: false
        })
      } else {
        await runMoveL(step.tcpPose, step.speed, controller.signal, { managePlayingState: false })
      }
    } catch (error) {
      const state = useRobotStore.getState()
      const runIsActive = runRobotId
        ? (state.robotExecutionById[runRobotId]?.isPlaying ?? false)
        : state.isPlaying

      if (runIsActive) {
        console.error('MoveL simulation failed:', error)
        setRunPlaying(false)
      }
    } finally {
      unsubscribe()
    }
  }

  const getTcpDistanceMm = (
    from: NonNullable<WorkflowStep['tcpPose']>,
    to: NonNullable<WorkflowStep['tcpPose']>
  ): number => {
    return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  }

  const validateWorkflowBeforeRun = (): string | null => {
    const moveLPolicy = getRobotRuntimeConfig().motionPolicy.moveL
    const robotState = useRobotStore.getState()
    let currentTcp = selectedRobotId
      ? (robotState.tcpPoseByRobotId[selectedRobotId] ?? robotState.tcpPose)
      : robotState.tcpPose

    for (const [index, step] of steps.entries()) {
      if (step.tcpPose) {
        if (step.type === 'MoveL') {
          const distance = getTcpDistanceMm(currentTcp, step.tcpPose)

          if (distance > moveLPolicy.maxDistanceMm) {
            return `Step ${index + 1} (${step.label}) MoveL quá xa: ${distance.toFixed(
              1
            )}mm > ${moveLPolicy.maxDistanceMm}mm. Hãy đổi step này thành MoveJ hoặc thêm waypoint trung gian.`
          }
        }

        currentTcp = step.tcpPose
      }
    }

    return null
  }

  // Simulation execution loop with smooth joint angle interpolation
  const runSimulation = async (): Promise<void> => {
    if (steps.length === 0) return
    const validationError = validateWorkflowBeforeRun()
    if (validationError) {
      setWorkflowError(validationError)
      setRunPlaying(false)
      return
    }

    setWorkflowError(null)
    moveLPreviewAbortRef.current?.abort()
    moveLPreviewAbortRef.current = null

    setRunPlaying(true)

    let currentIndex = currentStepIndex
    if (currentIndex >= steps.length) {
      currentIndex = 0
      setRunStepIndex(0)
    }

    while (currentIndex < steps.length && isRunActive()) {
      const step = steps[currentIndex]
      setSelectedStepId(step.id)
      if (
        (step.type === 'MoveJ' || step.type === 'RotateJoint' || step.type === 'MoveTCP') &&
        step.jointAngles
      ) {
        await animateJointMotion(step.jointAngles, step.speed)
      } else if (step.type === 'MoveL') {
        if (step.trace && step.jointAngles) {
          const groupId = step.trace.groupId
          const traceSteps: Array<
            WorkflowStep & { jointAngles: NonNullable<WorkflowStep['jointAngles']> }
          > = []
          let traceIndex = currentIndex

          while (traceIndex < steps.length) {
            const candidate = steps[traceIndex]
            if (
              candidate.type !== 'MoveL' ||
              candidate.trace?.groupId !== groupId ||
              !candidate.jointAngles
            ) {
              break
            }
            traceSteps.push(
              candidate as WorkflowStep & {
                jointAngles: NonNullable<WorkflowStep['jointAngles']>
              }
            )
            traceIndex += 1
          }

          // Replay one continuous time line. Planning each MoveL separately added a frame of
          // overhead per sample and made long drawings visibly slower than the recorded gesture.
          const previousStepAngles = steps[currentIndex - 1]?.jointAngles
          await animateRecordedTraceGroup(
            traceSteps,
            currentIndex,
            previousStepAngles ? ([...previousStepAngles] as JointAngles) : undefined
          )
          if (!isRunActive()) break
          currentIndex += traceSteps.length
          setRunStepIndex(currentIndex)
          continue
        } else {
          await runMoveLStep(step)
        }
      } else if (step.type === 'WaitMs') {
        // Wait delay duration
        const waitTime = (step.delayMs ?? 0) / useRobotStore.getState().playbackSpeed
        await wait(waitTime)
      } else if (step.type === 'GripperOpen') {
        const state = useRobotStore.getState()
        state.setGripperState('open')
        state.setDigitalOutput('cabinet', 1, 0)
        await wait(500)
      } else if (step.type === 'GripperClose') {
        const state = useRobotStore.getState()
        state.setGripperState('closed')
        state.setDigitalOutput('cabinet', 1, 1)
        await wait(500)
      } else if (
        step.type === 'SetDO' &&
        step.doIndex !== undefined &&
        step.doValue !== undefined
      ) {
        useRobotStore
          .getState()
          .setDigitalOutput(step.doType ?? 'cabinet', step.doIndex, step.doValue)
        await wait(100)
      } else {
        // Comments and unsupported local-only steps complete immediately.
        await wait(200 / useRobotStore.getState().playbackSpeed)
      }

      if (!isRunActive()) break

      currentIndex++
      setRunStepIndex(currentIndex)
    }

    setRunPlaying(false)
  }

  const handlePlay = (): void => {
    if (isRunActive()) {
      setRunPlaying(false)
    } else {
      setTimeout(() => runSimulation(), 10)
    }
  }

  const handleStop = (): void => {
    moveLPreviewAbortRef.current?.abort()
    moveLPreviewAbortRef.current = null

    setRunPlaying(false)
    setRunStepIndex(0)
    setSelectedStepId(null)
  }

  const handleClearAllSteps = (): void => {
    if (steps.length === 0 || isPlaying) return

    moveLPreviewAbortRef.current?.abort()
    moveLPreviewAbortRef.current = null
    setEditingStepId(null)
    setWorkflowError(null)
    clearSteps()
  }

  const moveDisplayRow = (rowIndex: number, direction: 'up' | 'down'): void => {
    const nextIndex = direction === 'up' ? rowIndex - 1 : rowIndex + 1
    if (nextIndex < 0 || nextIndex >= displayRows.length) return

    const reorderedRows = [...displayRows]
    const current = reorderedRows[rowIndex]
    reorderedRows[rowIndex] = reorderedRows[nextIndex]
    reorderedRows[nextIndex] = current
    reorderSteps(reorderedRows.flatMap((row) => row.steps))
  }

  const removeDisplayRow = (row: WorkflowDisplayRow): void => {
    if (!row.traceGroupId) {
      removeStep(row.steps[0].id)
      return
    }

    const removedIds = new Set(row.steps.map((step) => step.id))
    reorderSteps(steps.filter((step) => !removedIds.has(step.id)))
  }

  const moveStep = (index: number, direction: 'up' | 'down'): void => {
    const nextIndex = direction === 'up' ? index - 1 : index + 1
    if (nextIndex < 0 || nextIndex >= steps.length) return

    const newSteps = [...steps]
    const current = newSteps[index]
    newSteps[index] = newSteps[nextIndex]
    newSteps[nextIndex] = current
    reorderSteps(newSteps)
  }

  return (
    <div className="w-96 h-full bg-[#1b1b1f] border-l border-[#2d2d34] flex flex-col text-slate-200 select-none shrink-0">
      {/* Mode Switcher */}
      <div className="shrink-0 space-y-2 border-b border-[#2d2d34] bg-[#141417] p-3.5">
        <span className="block text-xs font-bold uppercase tracking-wider text-slate-400">
          {t('programmingMode')}
        </span>

        <div className="grid grid-cols-3 gap-1 rounded-lg border border-[#393942] bg-[#25252b] p-0.5">
          <button
            type="button"
            onClick={() => setMode('normal')}
            className={`flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-bold transition ${
              mode === 'normal'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sparkles size={10} />
            Scratch
          </button>

          <button
            type="button"
            onClick={() => setMode('advanced')}
            className={`flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-bold transition ${
              mode === 'advanced'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Code2 size={10} />
            List
          </button>

          <button
            type="button"
            onClick={() => setMode('import')}
            className={`flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-bold transition ${
              mode === 'import'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCode2 size={10} />
            LUA/JSON
          </button>
        </div>
      </div>
      {/* Mode Specific Sidebars */}
      {mode === 'normal' ? (
        <BlockWorkspace />
      ) : mode === 'import' ? (
        <ProgramImportPanel />
      ) : (
        // Advanced Mode: Flat commands list with manual waypoint recording
        <>
          {/* Waypoint Recorder */}
          <div className="space-y-3 border-b border-[#2d2d34] p-4">
            <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
              {t('recordWaypoint')}
            </span>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                onClick={() => handleRecordWaypoint('MoveJ')}
                disabled={isRecordBlocked}
                className="flex min-h-10 items-center justify-center gap-1.5 rounded bg-indigo-600 px-2 py-2 text-xs font-bold text-white shadow-md transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-[#25252b] disabled:text-slate-600 disabled:shadow-none"
              >
                <Plus size={12} />
                {t('recordMoveJ')}
                <InfoTooltip text={t('tooltipMoveJ')} />
              </button>

              <button
                onClick={() => handleRecordWaypoint('MoveL')}
                disabled={isRecordBlocked}
                className="flex min-h-10 items-center justify-center gap-1.5 rounded bg-blue-600 px-2 py-2 text-xs font-bold text-white shadow-md transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-[#25252b] disabled:text-slate-600 disabled:shadow-none"
              >
                <Plus size={12} />
                {t('recordMoveL')}
                <InfoTooltip text={t('tooltipMoveL')} />
              </button>

              <button
                onClick={handleRecordGripperOpen}
                disabled={isRecordBlocked}
                className="flex min-h-9 items-center justify-center gap-1.5 rounded border border-[#393942] bg-[#25252b] px-2 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-emerald-400 hover:text-white disabled:cursor-not-allowed disabled:border-[#2d2d34] disabled:bg-[#1a1a1f] disabled:text-slate-600"
              >
                <Unlock size={12} />
                {language === 'vi' ? 'Mo kep' : 'Open'}
              </button>

              <button
                onClick={handleRecordGripperClose}
                disabled={isRecordBlocked}
                className="flex min-h-9 items-center justify-center gap-1.5 rounded border border-[#393942] bg-[#25252b] px-2 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-rose-400 hover:text-white disabled:cursor-not-allowed disabled:border-[#2d2d34] disabled:bg-[#1a1a1f] disabled:text-slate-600"
              >
                <Lock size={12} />
                {language === 'vi' ? 'Dong kep' : 'Close'}
              </button>

              <button
                onClick={handleRecordWait}
                disabled={isRecordBlocked}
                className="flex min-h-9 items-center justify-center gap-1.5 rounded border border-[#393942] bg-[#25252b] px-2 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-amber-400 hover:text-white disabled:cursor-not-allowed disabled:border-[#2d2d34] disabled:bg-[#1a1a1f] disabled:text-slate-600"
              >
                <Clock size={12} />
                {language === 'vi' ? 'Cho 500ms' : 'Wait 500ms'}
              </button>

              <button
                onClick={handleAddDO}
                className="flex min-h-9 items-center justify-center gap-1.5 rounded border border-[#393942] bg-[#25252b] px-2 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-blue-400 hover:text-white"
              >
                <Plus size={12} />
                {t('setDO')}
                <InfoTooltip text={t('tooltipDO')} />
              </button>
            </div>

            {collisionWarning && (
              <p className="rounded border border-amber-500/30 bg-amber-950/20 px-2 py-1.5 text-[10px] leading-snug text-amber-200">
                {language === 'vi'
                  ? 'Dang co va cham. Hay Home hoac chinh pose truoc khi ghi.'
                  : 'Collision active. Resolve before recording.'}
              </p>
            )}
          </div>

          {/* Steps List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-2">
              {t('workflowSteps')} ({displayRows.length})
              {displayRows.length !== steps.length && (
                <span className="ml-1 font-normal normal-case text-slate-500">
                  · {steps.length} mẫu chuyển động
                </span>
              )}
            </span>

            {workflowError && (
              <div className="mx-4 mt-3 rounded border border-red-500/40 bg-red-950/30 px-3 py-2 text-xs text-red-200">
                {workflowError}
              </div>
            )}

            {steps.length === 0 ? (
              <div className="h-40 border border-dashed border-[#2d2d34] rounded-lg flex flex-col items-center justify-center text-slate-500 p-4 text-center">
                <span className="text-xs">{t('noSteps')}</span>
                <span className="text-[10px] mt-1">{t('useButtonsHint')}</span>
              </div>
            ) : displayRows.length < steps.length ? (
              displayRows.map((row, rowIndex) => {
                const step = row.steps.at(-1)!
                const isTrace = row.traceGroupId !== undefined
                const isSelected = row.steps.some((item) => item.id === selectedStepId)
                const isCurrentSim =
                  isPlaying &&
                  currentStepIndex >= row.startIndex &&
                  currentStepIndex <= row.endIndex
                const traceDurationMs = row.steps.reduce(
                  (total, item) => total + (item.trace?.segmentDurationMs ?? 0),
                  0
                )
                const activeTraceSample = Math.min(
                  row.steps.length,
                  Math.max(1, currentStepIndex - row.startIndex + 1)
                )

                return (
                  <div
                    key={row.key}
                    ref={(node) => {
                      if (node) stepCardRefs.current.set(row.key, node)
                      else stepCardRefs.current.delete(row.key)
                    }}
                    onClick={() => handleStepClick(step)}
                    className={`flex cursor-pointer items-start justify-between rounded-lg border p-3 text-left transition ${
                      isCurrentSim
                        ? 'border-emerald-500 bg-emerald-950/20'
                        : isSelected
                          ? 'border-blue-500 bg-blue-950/10'
                          : 'border-[#2d2d34] bg-[#121214] hover:bg-[#1a1a1f]'
                    }`}
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                            isTrace ? 'bg-cyan-900/60 text-cyan-300' : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {isTrace ? 'TRACE' : step.type}
                        </span>
                        <span className="block truncate text-xs font-bold text-white">
                          {isTrace
                            ? language === 'vi'
                              ? 'Quỹ đạo đã vẽ'
                              : 'Recorded trace'
                            : step.label || 'Unnamed'}
                        </span>
                      </div>

                      {isTrace ? (
                        <div className="mt-1.5 space-y-1 text-[10px] text-slate-400">
                          <p>
                            {row.steps.length} mẫu · {(traceDurationMs / 1000).toFixed(2)} giây
                          </p>
                          {isCurrentSim && (
                            <div className="space-y-1 text-emerald-300">
                              <p>
                                Đang chạy mẫu {activeTraceSample}/{row.steps.length}
                              </p>
                              <div className="h-1 overflow-hidden rounded bg-slate-800">
                                <div
                                  className="h-full bg-emerald-400 transition-[width] duration-75"
                                  style={{
                                    width: `${(activeTraceSample / row.steps.length) * 100}%`
                                  }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="mt-1 truncate font-mono text-[10px] text-slate-400">
                          {step.type}
                        </p>
                      )}
                    </div>

                    <div
                      className="flex shrink-0 items-center gap-1"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        onClick={() => moveDisplayRow(rowIndex, 'up')}
                        disabled={rowIndex === 0 || isPlaying}
                        className="cursor-pointer rounded p-1 text-slate-500 hover:bg-[#2d2d34] hover:text-slate-300 disabled:opacity-30"
                        title="Move Up"
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        onClick={() => moveDisplayRow(rowIndex, 'down')}
                        disabled={rowIndex === displayRows.length - 1 || isPlaying}
                        className="cursor-pointer rounded p-1 text-slate-500 hover:bg-[#2d2d34] hover:text-slate-300 disabled:opacity-30"
                        title="Move Down"
                      >
                        <ArrowDown size={12} />
                      </button>
                      {!isTrace && (
                        <button
                          onClick={() => setEditingStepId(step.id)}
                          disabled={isPlaying}
                          className="cursor-pointer rounded p-1 text-slate-500 hover:bg-[#2d2d34] hover:text-blue-400 disabled:opacity-30"
                          title="Settings"
                        >
                          <Settings size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => removeDisplayRow(row)}
                        disabled={isPlaying}
                        className="cursor-pointer rounded p-1 text-slate-500 hover:bg-rose-950/30 hover:text-rose-400 disabled:opacity-30"
                        title={isTrace ? 'Delete trace' : 'Delete'}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                )
              })
            ) : (
              steps.map((step, idx) => {
                const isSelected = selectedStepId === step.id
                const isCurrentSim = isPlaying && currentStepIndex === idx

                return (
                  <div
                    key={step.id}
                    ref={(node) => {
                      if (node) stepCardRefs.current.set(step.id, node)
                      else stepCardRefs.current.delete(step.id)
                    }}
                    onClick={() => handleStepClick(step)}
                    className={`p-3 rounded-lg border text-left cursor-pointer transition flex justify-between items-start ${
                      isCurrentSim
                        ? 'border-emerald-500 bg-emerald-950/20'
                        : isSelected
                          ? 'border-blue-500 bg-blue-950/10'
                          : 'border-[#2d2d34] bg-[#121214] hover:bg-[#1a1a1f]'
                    }`}
                  >
                    <div className="flex-1 min-w-0 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                            step.type === 'MoveJ' || step.type === 'RotateJoint'
                              ? 'bg-indigo-900/60 text-indigo-300'
                              : step.type === 'MoveL' || step.type === 'MoveTCP'
                                ? 'bg-blue-900/60 text-blue-300'
                                : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {step.type}
                        </span>
                        <span className="text-xs font-bold truncate text-white block">
                          {step.label || 'Unnamed'}
                        </span>
                      </div>

                      {step.type !== 'MoveL' && step.jointAngles && (
                        <div className="mt-1 text-[10px] text-slate-400 font-mono truncate">
                          Q: [
                          {step.jointAngles
                            .map((v) =>
                              angleUnit === 'rad' ? ((v * Math.PI) / 180).toFixed(2) : Math.round(v)
                            )
                            .join(', ')}
                          ] {angleUnit === 'rad' ? 'rad' : '°'}
                        </div>
                      )}
                      {step.type === 'WaitMs' && (
                        <p className="mt-1 text-[10px] text-slate-400 font-mono">
                          Trễ: {step.delayMs || 1000} ms
                        </p>
                      )}
                      {step.type === 'SetDO' && (
                        <p className="mt-1 text-[10px] text-slate-400 font-mono">
                          DO: {step.doType === 'tool' ? 'Tool' : 'Cabinet'} DO {step.doIndex} ={' '}
                          {step.doValue}
                        </p>
                      )}
                      {step.type === 'RotateJoint' && (
                        <p className="mt-1 text-[10px] text-slate-400 font-mono">
                          Quay J{step.jointIndex}: {step.angle}° ({step.rotateMode})
                        </p>
                      )}
                      {step.type === 'MoveTCP' && (
                        <p className="mt-1 text-[10px] text-slate-400 font-mono">
                          TCP Dịch {step.tcpAxis}: {step.distance} mm ({step.moveMode})
                        </p>
                      )}
                      {step.type === 'MoveL' && step.tcpPose && (
                        <p className="mt-1 text-[10px] text-blue-300 font-mono truncate">
                          TCP target: [{step.tcpPose.x.toFixed(1)}, {step.tcpPose.y.toFixed(1)},{' '}
                          {step.tcpPose.z.toFixed(1)}] mm
                        </p>
                      )}

                      {step.type === 'MoveL' && step.jointAngles && (
                        <p className="mt-1 text-[10px] text-slate-500 font-mono truncate">
                          IK Q: [
                          {step.jointAngles
                            .map((v) =>
                              angleUnit === 'rad' ? ((v * Math.PI) / 180).toFixed(2) : Math.round(v)
                            )
                            .join(', ')}
                          ] {angleUnit === 'rad' ? 'rad' : '°'}
                        </p>
                      )}

                      {(step.type === 'GripperOpen' || step.type === 'GripperClose') && (
                        <p className="mt-1 text-[10px] text-slate-400 font-mono">
                          Gripper: {step.type === 'GripperOpen' ? 'OPEN' : 'CLOSED'}
                        </p>
                      )}
                    </div>

                    {/* Move, Edit & Delete buttons */}
                    <div
                      className="flex items-center gap-1 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => moveStep(idx, 'up')}
                        disabled={idx === 0}
                        className="p-1 hover:bg-[#2d2d34] rounded text-slate-500 hover:text-slate-300 disabled:opacity-30 cursor-pointer"
                        title="Move Up"
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        onClick={() => moveStep(idx, 'down')}
                        disabled={idx === steps.length - 1}
                        className="p-1 hover:bg-[#2d2d34] rounded text-slate-500 hover:text-slate-300 disabled:opacity-30 cursor-pointer"
                        title="Move Down"
                      >
                        <ArrowDown size={12} />
                      </button>
                      <button
                        onClick={() => setEditingStepId(step.id)}
                        className="p-1 hover:bg-[#2d2d34] rounded text-slate-500 hover:text-blue-400 cursor-pointer"
                        title="Settings"
                      >
                        <Settings size={12} />
                      </button>
                      <button
                        onClick={() => removeStep(step.id)}
                        className="p-1 hover:bg-rose-950/30 rounded text-slate-500 hover:text-rose-400 cursor-pointer"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </>
      )}

      {/* Simulation Controls (Common) */}
      <div className="p-4 border-t border-[#2d2d34] bg-[#121214] flex items-center justify-between shrink-0">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          {t('simulation')}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleClearAllSteps}
            disabled={steps.length === 0 || isPlaying}
            className="mr-1 flex items-center gap-1.5 rounded border border-rose-500/50 px-2 py-1.5 text-[10px] font-semibold text-rose-300 transition hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-600"
            title={language === 'vi' ? 'Xóa toàn bộ command' : 'Delete all commands'}
          >
            <Trash2 size={13} />
            <span>{language === 'vi' ? 'Xóa tất cả' : 'Clear all'}</span>
          </button>
          <button
            onClick={handlePlay}
            className={`p-2 rounded transition cursor-pointer ${
              isPlaying
                ? 'bg-amber-600 hover:bg-amber-500 text-white'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
            title={isPlaying ? t('pause') : t('play')}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            onClick={handleStop}
            className="p-2 bg-rose-600 hover:bg-rose-500 text-white rounded transition cursor-pointer"
            title={t('stop')}
          >
            <Square size={14} />
          </button>
        </div>
      </div>

      {editingStep && (
        <WorkflowStepDetailsModal
          step={editingStep}
          isOpen={!!editingStep}
          onClose={() => setEditingStepId(null)}
          updateStep={updateStep}
          angleUnit={angleUnit}
          lengthUnit={lengthUnit}
          isPlaying={isPlaying}
          language={language}
        />
      )}
    </div>
  )
}
