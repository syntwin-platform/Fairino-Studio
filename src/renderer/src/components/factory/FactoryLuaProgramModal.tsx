import { useRef, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import { AlertTriangle, FileCode2, Play, Square } from 'lucide-react'

import CenterModal from '../ui/CenterModal'
import ProgramImportPanel from '../workflow/ProgramImportPanel'
import { useFactoryProgramStore } from '../../store/factoryProgramStore'
import { useRobotStore } from '../../store/robotStore'
import type { BackendRobot } from '../../services/backendRobotClient'
import type { BackendSimulatorConfigByRobotId } from '../../types/backendDevice'
import {
  cancelFactoryProgramV2,
  executeFactoryProgramV2
} from '../../services/factoryRunOrchestrator'
import { cancelActiveCommandForRobot } from '../../services/commandExecutionRuntime'
import { getRobotRuntimeConfig as fetchRobotRuntimeConfig } from '../../services/backendRuntimeConfigClient'
import { setRobotRuntimeConfig } from '../../services/robotMotionRuntime'
import {
  getFactoryRunDiagnosticSnapshot,
  recordFactoryRunDiagnostic,
  subscribeFactoryRunDiagnostics
} from '../../services/factoryRunDiagnostics'

interface FactoryLuaProgramModalProps {
  robots: BackendRobot[]
  backendUrl: string
  token: string
  simulatorConfigByRobotId: BackendSimulatorConfigByRobotId
}

export default function FactoryLuaProgramModal({
  robots,
  backendUrl,
  token,
  simulatorConfigByRobotId
}: FactoryLuaProgramModalProps): JSX.Element {
  const abortRef = useRef<AbortController | null>(null)
  const diagnosticSnapshot = useSyncExternalStore(
    subscribeFactoryRunDiagnostics,
    getFactoryRunDiagnosticSnapshot,
    getFactoryRunDiagnosticSnapshot
  )
  const isOpen = useFactoryProgramStore((state) => state.isModalOpen)
  const scope = useFactoryProgramStore((state) => state.scope)
  const activeRobotId = useFactoryProgramStore((state) => state.activeRobotId)
  const targetRobotIds = useFactoryProgramStore((state) => state.targetRobotIds)
  const program = useFactoryProgramStore((state) => state.program)
  const robotStates = useFactoryProgramStore((state) => state.robotStates)
  const run = useFactoryProgramStore((state) => state.run)
  const isBusy = useFactoryProgramStore((state) => state.isBusy)

  const closeModal = useFactoryProgramStore((state) => state.closeModal)
  const setProgram = useFactoryProgramStore((state) => state.setProgram)
  const setTargetSelected = useFactoryProgramStore((state) => state.setTargetSelected)
  const setTargets = useFactoryProgramStore((state) => state.setTargets)
  const setRunMetadata = useFactoryProgramStore((state) => state.setRunMetadata)

  const runtimeById = useRobotStore((state) => state.robotRuntimeById)
  const executionById = useRobotStore((state) => state.robotExecutionById)

  const validatorRobotId = scope === 'single' ? activeRobotId : (targetRobotIds[0] ?? null)

  const getReadinessErrors = (robot: BackendRobot): string[] => {
    const errors: string[] = []
    const config = simulatorConfigByRobotId[robot.id]
    const runtime = runtimeById[robot.id]
    const execution = executionById[robot.id]

    if (robot.status.toLowerCase() === 'disabled') {
      errors.push('Robot is disabled')
    }

    if (!config?.deviceSecret?.trim()) {
      errors.push('Missing Device Secret')
    }

    if (!runtime?.isConnected) {
      errors.push('Robot is offline')
    }

    if (execution?.isPlaying) {
      errors.push('Robot is busy')
    }

    return errors
  }

  const selectedRobots = robots.filter((robot) => targetRobotIds.includes(robot.id))

  const readiness = selectedRobots.map((robot) => ({
    robot,
    errors: getReadinessErrors(robot)
  }))

  const allReady = selectedRobots.length > 0 && readiness.every((item) => item.errors.length === 0)

  const selectedRobotStates = selectedRobots.map((robot) => robotStates[robot.id])

  const completedCount = selectedRobotStates.filter((state) => state?.status === 'completed').length
  const failedCount = selectedRobotStates.filter((state) => state?.status === 'failed').length
  const cancelledCount = selectedRobotStates.filter((state) => state?.status === 'cancelled').length
  const readyCount = selectedRobotStates.filter((state) => state?.status === 'ready').length
  const runningCount = selectedRobotStates.filter((state) => state?.status === 'running').length

  const progressLabel = `${completedCount}/${selectedRobots.length} completed`

  const handleRun = async (): Promise<void> => {
    if (!program) {
      setRunMetadata({
        status: 'failed',
        error: 'Import and accept a LUA program first.'
      })
      return
    }

    if (!allReady) {
      setRunMetadata({
        status: 'failed',
        error: 'Every selected robot must be online, idle and configured.'
      })
      return
    }

    const companyIds = [...new Set(selectedRobots.map((robot) => robot.companyId).filter(Boolean))]

    if (companyIds.length !== 1) {
      setRunMetadata({
        status: 'failed',
        error: 'All selected robots must belong to exactly one company.'
      })
      return
    }
    const runtimePolicyStartedAtMonotonicMs = performance.now()

    recordFactoryRunDiagnostic('runtime-policy.started', {
      details: {
        targetCount: selectedRobots.length
      }
    })

    try {
      const runtimeConfigs = await Promise.all(
        selectedRobots.map((robot) => fetchRobotRuntimeConfig(backendUrl, robot.id, token))
      )

      for (const runtimeConfig of runtimeConfigs) {
        setRobotRuntimeConfig(runtimeConfig)
      }
      recordFactoryRunDiagnostic('runtime-policy.completed', {
        durationMs: performance.now() - runtimePolicyStartedAtMonotonicMs,
        details: {
          targetCount: runtimeConfigs.length
        }
      })
    } catch (error) {
      recordFactoryRunDiagnostic('runtime-policy.failed', {
        durationMs: performance.now() - runtimePolicyStartedAtMonotonicMs,
        details: {
          reasonCode: 'runtime_policy_refresh_failed'
        }
      })
      setRunMetadata({
        status: 'failed',
        error:
          error instanceof Error
            ? `Runtime policy refresh failed: ${error.message}`
            : 'Runtime policy refresh failed.'
      })
      return
    }

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await executeFactoryProgramV2(
        { backendUrl, token },
        program,
        selectedRobots.map((robot) => ({
          robotId: robot.id,
          robotName: robot.robotName,
          companyId: robot.companyId
        })),
        controller.signal
      )
    } catch {
      // Orchestrator already wrote detailed state.
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
      }
    }
  }

  const handleCancel = async (): Promise<void> => {
    const factoryRunId = useFactoryProgramStore.getState().run.factoryRunId

    if (factoryRunId) {
      try {
        await cancelFactoryProgramV2({ backendUrl, token }, factoryRunId)
      } catch (error) {
        setRunMetadata({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Factory run cancel failed.'
        })
      }
    }

    abortRef.current?.abort()

    for (const robotId of targetRobotIds) {
      cancelActiveCommandForRobot(robotId, 'Factory run cancelled by user')
    }
  }

  return (
    <CenterModal
      open={isOpen}
      onClose={closeModal}
      size="xl"
      icon={<FileCode2 size={18} />}
      title={
        scope === 'single'
          ? `LUA Program - ${
              robots.find((robot) => robot.id === activeRobotId)?.robotName ?? 'Robot'
            }`
          : 'Factory synchronized LUA program'
      }
      subtitle={
        scope === 'single'
          ? 'Validate and run without switching to Train mode'
          : 'Prepare one LUA program for multiple robots'
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {validatorRobotId ? (
            <ProgramImportPanel
              luaOnly
              factoryDiagnostics
              requestContext={{
                backendUrl,
                robotId: validatorRobotId,
                token
              }}
              actionLabel="Use this LUA program"
              onProgramAccepted={setProgram}
            />
          ) : (
            <p className="rounded border border-amber-500/40 p-3 text-xs text-amber-200">
              Select at least one robot before importing LUA.
            </p>
          )}
        </div>

        <div className="min-w-0 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase text-slate-300">Target robots</h3>

            {scope === 'batch' && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() =>
                  setTargets(
                    robots
                      .filter((robot) => getReadinessErrors(robot).length === 0)
                      .map((robot) => robot.id)
                  )
                }
                className="text-[10px] font-semibold text-blue-300"
              >
                Select ready
              </button>
            )}
          </div>

          <div className="max-h-72 space-y-2 overflow-y-auto">
            {robots
              .filter((robot) => scope === 'batch' || robot.id === activeRobotId)
              .map((robot) => {
                const selected = targetRobotIds.includes(robot.id)
                const errors = getReadinessErrors(robot)
                const state = robotStates[robot.id]

                return (
                  <label
                    key={robot.id}
                    className="flex gap-2 rounded border border-[#343849] bg-[#0c0e16] p-2"
                  >
                    {scope === 'batch' && (
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={isBusy}
                        onChange={(event) => setTargetSelected(robot.id, event.target.checked)}
                      />
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-white">{robot.robotName}</p>

                      <p className="text-[10px] text-slate-500">{state?.status ?? 'idle'}</p>

                      {errors.map((error) => (
                        <p key={error} className="text-[9px] text-amber-300">
                          {error}
                        </p>
                      ))}

                      {state?.message && (
                        <p className="mt-1 break-words text-[9px] text-slate-300">
                          {state.message}
                        </p>
                      )}
                    </div>
                  </label>
                )
              })}
          </div>

          {program && (
            <div className="rounded border border-emerald-500/30 bg-emerald-950/20 p-2 text-[10px] text-emerald-200">
              {program.fileName}: {program.steps.length} valid step(s)
            </div>
          )}

          {run.error && (
            <div className="flex gap-2 rounded border border-red-500/40 bg-red-950/25 p-2 text-[10px] text-red-200">
              <AlertTriangle size={13} />
              <span>{run.error}</span>
            </div>
          )}

          <div className="rounded border border-[#343849] bg-[#080a10] p-2 text-[10px] text-slate-300">
            <p>
              Factory status: <span className="font-bold text-white">{run.status}</span>
            </p>
            <p className="mt-1">
              Coordination:{' '}
              <span className="font-semibold text-blue-300">{run.coordinationMode}</span>
            </p>

            <p className="mt-1">
              Failure policy:{' '}
              <span className="font-semibold text-amber-300">{run.failurePolicy}</span>
            </p>

            {run.factoryRunId && (
              <p className="mt-1 break-all text-slate-500">Run ID: {run.factoryRunId}</p>
            )}

            {run.scheduledStartAtUtc && (
              <p className="mt-1 text-emerald-300">
                Scheduled start: {new Date(run.scheduledStartAtUtc).toLocaleTimeString()}
              </p>
            )}

            {run.actualStartSkewMs !== null && (
              <p
                className={`mt-1 ${
                  run.actualStartSkewMs <= 50 ? 'text-emerald-300' : 'text-amber-300'
                }`}
              >
                Inter-robot start skew: {Math.round(run.actualStartSkewMs)} ms
              </p>
            )}

            {run.maxStartShiftMs !== null && (
              <p className="mt-1 text-slate-400">
                Max shared start shift: {Math.round(run.maxStartShiftMs)} ms
              </p>
            )}

            {diagnosticSnapshot.sessionId && (
              <div className="mt-2 border-t border-[#343849] pt-2 text-[9px] text-slate-400">
                <p>
                  Diagnostic stage:{' '}
                  <span className="text-slate-200">
                    {diagnosticSnapshot.summary.currentStage ?? 'idle'}
                  </span>
                </p>

                <p>Total measured: {Math.round(diagnosticSnapshot.summary.totalElapsedMs)} ms</p>

                {diagnosticSnapshot.summary.luaParseMs !== null && (
                  <p>Lua parse: {Math.round(diagnosticSnapshot.summary.luaParseMs)} ms</p>
                )}

                {diagnosticSnapshot.summary.factoryPrepareMs !== null && (
                  <p>
                    Factory prepare: {Math.round(diagnosticSnapshot.summary.factoryPrepareMs)} ms
                  </p>
                )}

                {diagnosticSnapshot.summary.maxRobotPreparationMs !== null && (
                  <p>
                    Slowest robot preparation:{' '}
                    {Math.round(diagnosticSnapshot.summary.maxRobotPreparationMs)} ms
                  </p>
                )}

                {diagnosticSnapshot.summary.maxArmPollMs !== null && (
                  <p>
                    Slowest arm request: {Math.round(diagnosticSnapshot.summary.maxArmPollMs)} ms
                  </p>
                )}
              </div>
            )}

            {selectedRobots.length > 0 && (
              <div className="mt-2 grid grid-cols-5 gap-1 text-center">
                <div className="rounded bg-slate-900 px-1 py-1">
                  <p className="text-[8px] uppercase text-slate-500">Ready</p>
                  <p className="font-bold text-blue-300">{readyCount}</p>
                </div>

                <div className="rounded bg-slate-900 px-1 py-1">
                  <p className="text-[8px] uppercase text-slate-500">Running</p>
                  <p className="font-bold text-violet-300">{runningCount}</p>
                </div>

                <div className="rounded bg-slate-900 px-1 py-1">
                  <p className="text-[8px] uppercase text-slate-500">Done</p>
                  <p className="font-bold text-emerald-300">{completedCount}</p>
                </div>

                <div className="rounded bg-slate-900 px-1 py-1">
                  <p className="text-[8px] uppercase text-slate-500">Failed</p>
                  <p className="font-bold text-red-300">{failedCount}</p>
                </div>

                <div className="rounded bg-slate-900 px-1 py-1">
                  <p className="text-[8px] uppercase text-slate-500">Cancel</p>
                  <p className="font-bold text-amber-300">{cancelledCount}</p>
                </div>
              </div>
            )}

            {selectedRobots.length > 0 && (
              <p className="mt-2 text-[9px] text-slate-500">{progressLabel}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={isBusy || !program || !allReady || !token}
              onClick={() => void handleRun()}
              className="flex items-center justify-center gap-1 rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
            >
              <Play size={13} />
              {scope === 'single' ? 'Create & Run' : 'Create FactoryRun'}
            </button>

            <button
              type="button"
              disabled={!isBusy}
              onClick={() => void handleCancel()}
              className="flex items-center justify-center gap-1 rounded border border-red-500/50 px-3 py-2 text-xs font-bold text-red-300 disabled:opacity-40"
            >
              <Square size={12} />
              Cancel
            </button>
          </div>
        </div>
      </div>
    </CenterModal>
  )
}
