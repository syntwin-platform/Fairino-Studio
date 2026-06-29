import type { ReactElement } from 'react'

import { useRobotStore } from '../../store/robotStore'
import { useSceneStore } from '../../store/sceneStore'
import type { WorkflowStep } from '../../types/robot.types'
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
  Trash2
} from 'lucide-react'
import BlockWorkspace from './BlockWorkspace'
import { translations } from '../../i18n/translations'
import ProgramImportPanel from './ProgramImportPanel'

const DEFAULT_SPEED = 30
const DEFAULT_ACC = 30
const DEFAULT_WAIT_MS = 500


interface InfoTooltipProps {
  text: string
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
  const reorderSteps = useRobotStore((state) => state.reorderSteps)
  const jointAngles = useRobotStore((state) => state.jointAngles)
  const tcpPose = useRobotStore((state) => state.tcpPose)
  const selectedStepId = useRobotStore((state) => state.selectedStepId)
  const setSelectedStepId = useRobotStore((state) => state.setSelectedStepId)
  const setJointAngles = useRobotStore((state) => state.setJointAngles)
  const updateStep = useRobotStore((state) => state.updateStep)

  // Mode state
  const mode = useRobotStore((state) => state.mode)
  const setMode = useRobotStore((state) => state.setMode)
  const angleUnit = useRobotStore((state) => state.angleUnit)

  // Language translation helper
  const language = useRobotStore((state) => state.language)
  const t = (key: keyof typeof translations.vi): string => translations[language][key]

  // Simulation states
  const isPlaying = useRobotStore((state) => state.isPlaying)
  const setPlaying = useRobotStore((state) => state.setPlaying)
  const currentStepIndex = useRobotStore((state) => state.currentStepIndex)
  const setCurrentStepIndex = useRobotStore((state) => state.setCurrentStepIndex)
  const collisionWarning = useSceneStore((state) => state.collisionWarning)
  const isRecordBlocked = isPlaying || collisionWarning

   const handleRecordWaypoint = (type: 'MoveJ' | 'MoveL'): void => {
    if (isRecordBlocked) return

    const pointNum = steps.filter((s) => s.type === 'MoveJ' || s.type === 'MoveL').length + 1

    addStep({
      type,
      label: `${type} - Waypoint ${pointNum}`,
      jointAngles: [...jointAngles],
      tcpPose: { ...tcpPose },
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

  const handleStepClick = (step: WorkflowStep): void => {
    setSelectedStepId(step.id)
    if (step.jointAngles) {
      setJointAngles(step.jointAngles)
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

  // Simulation execution loop with smooth joint angle interpolation
  const runSimulation = async (): Promise<void> => {
    if (steps.length === 0) return
    setPlaying(true)

    let currentIndex = currentStepIndex
    if (currentIndex >= steps.length) {
      currentIndex = 0
      setCurrentStepIndex(0)
    }

    while (currentIndex < steps.length && useRobotStore.getState().isPlaying) {
      const step = steps[currentIndex]
      setSelectedStepId(step.id)

      if (['MoveJ', 'MoveL', 'RotateJoint', 'MoveTCP'].includes(step.type) && step.jointAngles) {
        // Smoothly interpolate from current joints to target joints
        const startAngles = [...useRobotStore.getState().jointAngles]
        const targetAngles = step.jointAngles
        const duration =
          getMotionDurationMs(startAngles, targetAngles, step.speed) /
          useRobotStore.getState().playbackSpeed // 1 second duration adjusted by playback speed
        const stepsCount = 30 // 30 frames of animation
        const intervalTime = duration / stepsCount

        for (let i = 1; i <= stepsCount; i++) {
          if (!useRobotStore.getState().isPlaying) break
          const t = i / stepsCount
          const interpolated = startAngles.map((start, idx) => {
            const target = targetAngles[idx]
            return start + (target - start) * t
          })
          setJointAngles(interpolated as typeof targetAngles)
          await new Promise((resolve) => setTimeout(resolve, intervalTime))
        }
      } else if (step.type === 'WaitMs') {
        // Wait delay duration
        const waitTime = (step.delayMs ?? 0) / useRobotStore.getState().playbackSpeed
        await new Promise((resolve) => setTimeout(resolve, waitTime))
      } else if (step.type === 'GripperOpen') {
        const state = useRobotStore.getState()
        state.setGripperState('open')
        state.setDigitalOutput('cabinet', 1, 0)
        await new Promise((resolve) => setTimeout(resolve, 500))
      } else if (step.type === 'GripperClose') {
        const state = useRobotStore.getState()
        state.setGripperState('closed')
        state.setDigitalOutput('cabinet', 1, 1)
        await new Promise((resolve) => setTimeout(resolve, 500))
      } else if (
        step.type === 'SetDO' &&
        step.doIndex !== undefined &&
        step.doValue !== undefined
      ) {
        useRobotStore
          .getState()
          .setDigitalOutput(step.doType ?? 'cabinet', step.doIndex, step.doValue)
        await new Promise((resolve) => setTimeout(resolve, 100))
      } else {
        // Comments and unsupported local-only steps complete immediately.
        await new Promise((resolve) =>
          setTimeout(resolve, 200 / useRobotStore.getState().playbackSpeed)
        )
      }

      if (!useRobotStore.getState().isPlaying) break

      currentIndex++
      setCurrentStepIndex(currentIndex)
    }

    setPlaying(false)
  }

  const handlePlay = (): void => {
    if (isPlaying) {
      setPlaying(false)
    } else {
      setTimeout(() => runSimulation(), 10)
    }
  }

  const handleStop = (): void => {
    setPlaying(false)
    setCurrentStepIndex(0)
    setSelectedStepId(null)
  }

  const moveStep = (index: number, direction: 'up' | 'down'): void => {
    const nextIndex = direction === 'up' ? index - 1 : index + 1
    if (nextIndex < 0 || nextIndex >= steps.length) return

    const newSteps = [...steps]
    const temp = newSteps[index]
    newSteps[index] = newSteps[nextIndex]
    newSteps[nextIndex] = temp
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
              {t('workflowSteps')} ({steps.length})
            </span>

            {steps.length === 0 ? (
              <div className="h-40 border border-dashed border-[#2d2d34] rounded-lg flex flex-col items-center justify-center text-slate-500 p-4 text-center">
                <span className="text-xs">{t('noSteps')}</span>
                <span className="text-[10px] mt-1">{t('useButtonsHint')}</span>
              </div>
            ) : (
              steps.map((step, idx) => {
                const isSelected = selectedStepId === step.id
                const isCurrentSim = isPlaying && currentStepIndex === idx

                return (
                  <div
                    key={step.id}
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

                      {step.jointAngles && (
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
                      {step.type === 'WaitMs' && step.delayMs !== undefined && (
                        <div
                          className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-400"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span>{language === 'vi' ? 'Trễ:' : 'Delay:'}</span>
                          <input
                            type="number"
                            value={step.delayMs}
                            onChange={(e) => {
                              const val = parseInt(e.target.value) || 0
                              updateStep(step.id, {
                                delayMs: val,
                                label: language === 'vi' ? `Đợi trễ ${val}ms` : `Wait ${val}ms`
                              })
                            }}
                            disabled={isPlaying}
                            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 w-16 text-center text-[10px] font-mono font-bold text-white outline-none"
                          />
                          <span>ms</span>
                        </div>
                      )}
                      {step.type === 'SetDO' && step.doIndex !== undefined && (
                        <div
                          className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-400"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <select
                            value={step.doType || 'cabinet'}
                            onChange={(e) => {
                              const newType = e.target.value as 'cabinet' | 'tool'
                              const newIdx = newType === 'tool' ? 0 : 1
                              updateStep(step.id, {
                                doType: newType,
                                doIndex: newIdx,
                                label:
                                  language === 'vi'
                                    ? `Cài đặt ${newType === 'tool' ? 'Tool DO' : 'DO'} ${newIdx}`
                                    : `Set ${newType === 'tool' ? 'Tool DO' : 'DO'} ${newIdx}`
                              })
                            }}
                            disabled={isPlaying}
                            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-white font-semibold outline-none cursor-pointer"
                          >
                            <option value="cabinet">{t('cabinetDO')}</option>
                            <option value="tool">{t('toolDO')}</option>
                          </select>
                          <select
                            value={step.doIndex}
                            onChange={(e) => {
                              const val = parseInt(e.target.value)
                              const type = step.doType || 'cabinet'
                              updateStep(step.id, {
                                doIndex: val,
                                label:
                                  language === 'vi'
                                    ? `Cài đặt ${type === 'tool' ? 'Tool DO' : 'DO'} ${val}`
                                    : `Set ${type === 'tool' ? 'Tool DO' : 'DO'} ${val}`
                              })
                            }}
                            disabled={isPlaying}
                            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-white font-semibold outline-none cursor-pointer"
                          >
                            {((step.doType || 'cabinet') === 'tool'
                              ? [0, 1]
                              : [1, 2, 3, 4, 5, 6, 7, 8]
                            ).map((num) => (
                              <option key={num} value={num}>
                                {(step.doType || 'cabinet') === 'tool'
                                  ? `End-DO ${num}`
                                  : `DO ${num}`}
                              </option>
                            ))}
                          </select>
                          <span>=</span>
                          <select
                            value={step.doValue ?? 1}
                            onChange={(e) => {
                              const val = parseInt(e.target.value) as 0 | 1
                              updateStep(step.id, { doValue: val })
                            }}
                            disabled={isPlaying}
                            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-white font-semibold outline-none cursor-pointer"
                          >
                            <option value={1}>{t('turnOn')}</option>
                            <option value={0}>{t('turnOff')}</option>
                          </select>
                        </div>
                      )}
                    </div>

                    {/* Move & Delete buttons */}
                    <div
                      className="flex items-center gap-1 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => moveStep(idx, 'up')}
                        disabled={idx === 0}
                        className="p-1 hover:bg-[#2d2d34] rounded text-slate-500 hover:text-slate-300 disabled:opacity-30 cursor-pointer"
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        onClick={() => moveStep(idx, 'down')}
                        disabled={idx === steps.length - 1}
                        className="p-1 hover:bg-[#2d2d34] rounded text-slate-500 hover:text-slate-300 disabled:opacity-30 cursor-pointer"
                      >
                        <ArrowDown size={12} />
                      </button>
                      <button
                        onClick={() => removeStep(step.id)}
                        className="p-1 hover:bg-rose-950/30 rounded text-slate-500 hover:text-rose-400 cursor-pointer"
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
    </div>
  )
}
