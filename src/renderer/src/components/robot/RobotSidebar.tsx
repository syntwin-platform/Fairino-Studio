import { Cpu, HelpCircle, Home, Settings } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { translations } from '../../i18n/translations'
import { useRobotStore } from '../../store/robotStore'
import { useSceneStore } from '../../store/sceneStore'
import { DEFAULT_JOINT_ANGLES, type JointAngles } from '../../types/robot.types'
import { cancelActiveCommand } from '../../services/commandExecutionRuntime'
import ScenePanel from '../scene/ScenePanel'

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

const JOINT_BOUNDS = [
  { min: -175, max: 175 },
  { min: -265, max: 85 },
  { min: -160, max: 160 },
  { min: -265, max: 85 },
  { min: -175, max: 175 },
  { min: -175, max: 175 }
]

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
}

export default function RobotSidebar(): ReactElement {
  const [activeTab, setActiveTab] = useState<'robot' | 'scene'>('robot')
  const [isHoming, setIsHoming] = useState(false)
  const homeRunIdRef = useRef(0)

  const jointAngles = useRobotStore((state) => state.jointAngles)
  const setJointAngles = useRobotStore((state) => state.setJointAngles)
  const setPlaying = useRobotStore((state) => state.setPlaying)
  const setCurrentStepIndex = useRobotStore((state) => state.setCurrentStepIndex)
  const setSelectedStepId = useRobotStore((state) => state.setSelectedStepId)
  const tcpPose = useRobotStore((state) => state.tcpPose)
  const isIKMode = useRobotStore((state) => state.isIKMode)
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

  const handleJointChange = (idx: number, val: number): void => {
    const updated = [...jointAngles] as JointAngles
    updated[idx] = Math.round(val * 10) / 10
    setJointAngles(updated)
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

  return (
    <div className="flex h-full w-80 shrink-0 select-none flex-col border-r border-[#2d2d34] bg-[#1b1b1f] text-slate-200">
      <div className="border-b border-[#2d2d34] p-4">
        <h2 className="flex items-center gap-2 text-lg font-bold text-white">
          <span className="h-3 w-3 animate-pulse rounded-full bg-emerald-500" />
          Fairino FR5 Controller
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          {t('payload')}: 5kg | {t('reach')}: 924mm | 6-DOF
        </p>
      </div>

      <div className="flex border-b border-[#2d2d34] bg-[#141417]">
        <button
          type="button"
          onClick={() => setActiveTab('robot')}
          className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 text-xs font-semibold transition ${
            activeTab === 'robot'
              ? 'border-blue-500 bg-[#1b1b1f] text-white'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Cpu size={14} /> Robot
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('scene')}
          className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 text-xs font-semibold transition ${
            activeTab === 'scene'
              ? 'border-blue-500 bg-[#1b1b1f] text-white'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Settings size={14} /> {t('deviceList')}
        </button>
      </div>

      {activeTab === 'robot' ? (
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
      ) : (
        <ScenePanel />
      )}
    </div>
  )
}
