import { useFactoryProgramStore } from '../store/factoryProgramStore'
import {
  DEFAULT_FACTORY_COORDINATION_MODE,
  DEFAULT_FACTORY_FAILURE_POLICY
} from '../types/factoryProgram.types'
import type {
  FactoryRobotProgramStatus,
  FactoryRunStatus,
  ValidatedLuaProgram
} from '../types/factoryProgram.types'
import {
  cancelFactoryRun,
  createFactoryRun,
  getFactoryRun,
  prepareFactoryRun,
  startFactoryRun,
  type BackendFactoryRunContext,
  type FactoryRunResponse,
  type FactoryRunTargetResponse
} from './backendFactoryRunClient'
import {
  attachFactoryRunDiagnosticId,
  endFactoryRunDiagnosticSession,
  recordFactoryRunDiagnostic
} from './factoryRunDiagnostics'

export interface FactoryRunTarget {
  robotId: string
  robotName: string
  companyId: string
}

const TERMINAL_FACTORY_RUN_STATUSES = new Set([
  'Completed',
  'PartiallyCompleted',
  'Failed',
  'Cancelled'
])

const READY_FACTORY_RUN_STATUSES = new Set(['Ready', 'Failed', 'Cancelled'])

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const timeoutId = window.setTimeout(resolve, milliseconds)

    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeoutId)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

function getAbortAwareError(error: unknown): Error {
  if (error instanceof Error) return error

  return new Error('Factory run failed.')
}

function normalizeBackendRunStatus(status: string): FactoryRunStatus {
  switch (status) {
    case 'Created':
      return 'created'
    case 'Preparing':
    case 'Prepared':
      return 'preparing'
    case 'WaitingForReady':
      return 'waiting-ready'
    case 'Ready':
      return 'ready'
    case 'Starting':
      return 'starting'
    case 'Running':
      return 'running'
    case 'RunningDegraded':
      return 'running-degraded'
    case 'Completed':
      return 'completed'
    case 'PartiallyCompleted':
      return 'partially-completed'
    case 'Failed':
      return 'failed'
    case 'Cancelling':
      return 'cancelling'
    case 'Cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

function normalizeBackendTargetStatus(status: string): FactoryRobotProgramStatus {
  switch (status) {
    case 'Pending':
      return 'idle'
    case 'Preparing':
      return 'preparing'
    case 'Prepared':
      return 'prepared'
    case 'WaitingForDeviceReady':
      return 'waiting-ready'
    case 'Ready':
      return 'ready'
    case 'Starting':
      return 'waiting-start'
    case 'Armed':
      return 'armed'
    case 'Running':
      return 'running'
    case 'Completed':
      return 'completed'
    case 'Failed':
      return 'failed'
    case 'Cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

function getTargetMessage(target: FactoryRunTargetResponse): string {
  return target.failureReason || target.readinessError || target.status
}

function applyFactoryRunResponse(response: FactoryRunResponse): void {
  const store = useFactoryProgramStore.getState()
  const reportedStartShiftsMs = response.targets
    .map((target) => target.startLateByMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  store.setRunMetadata({
    factoryRunId: response.id,
    coordinationMode: response.coordinationMode ?? DEFAULT_FACTORY_COORDINATION_MODE,
    failurePolicy: response.failurePolicy ?? DEFAULT_FACTORY_FAILURE_POLICY,
    scheduledStartAtUtc: response.scheduledStartAtUtc ?? null,
    actualStartSkewMs: response.actualStartSkewMs ?? null,
    maxStartShiftMs: reportedStartShiftsMs.length > 0 ? Math.max(...reportedStartShiftsMs) : null,
    status: normalizeBackendRunStatus(response.status),
    error: response.failureReason ?? null
  })

  for (const target of response.targets) {
    store.patchRobotState(target.robotId, {
      status: normalizeBackendTargetStatus(target.status),
      programId: target.programId ?? undefined,
      prepareCommandId: target.prepareCommandId ?? undefined,
      commandId: target.commandId ?? undefined,
      message: getTargetMessage(target),
      startedAt: target.startedAtUtc ?? undefined,
      completedAt: target.completedAtUtc ?? undefined
    })
  }
}

async function waitForFactoryRunStatus(
  context: BackendFactoryRunContext,
  factoryRunId: string,
  stopStatuses: Set<string>,
  signal?: AbortSignal
): Promise<FactoryRunResponse> {
  let latest: FactoryRunResponse | null = null

  for (let attempt = 0; attempt < 900; attempt++) {
    latest = await getFactoryRun(context, factoryRunId, signal)
    applyFactoryRunResponse(latest)

    if (stopStatuses.has(latest.status)) {
      return latest
    }

    await wait(stopStatuses === READY_FACTORY_RUN_STATUSES ? 250 : 1000, signal)
  }

  throw new Error(`Factory run ${factoryRunId} monitoring timed out.`)
}

function getSingleCompanyId(targets: FactoryRunTarget[]): string {
  const companyIds = [...new Set(targets.map((target) => target.companyId).filter(Boolean))]

  if (companyIds.length !== 1) {
    throw new Error('All selected robots must belong to exactly one company.')
  }

  return companyIds[0]
}

export async function executeFactoryProgramV2(
  context: BackendFactoryRunContext,
  program: ValidatedLuaProgram,
  targets: FactoryRunTarget[],
  signal?: AbortSignal
): Promise<void> {
  if (targets.length === 0) {
    throw new Error('No robot was selected.')
  }

  const store = useFactoryProgramStore.getState()
  const coordinationMode = store.run.coordinationMode
  const failurePolicy = store.run.failurePolicy
  const companyId = getSingleCompanyId(targets)

  store.setBusy(true)
  store.setRunMetadata({
    factoryRunId: null,
    coordinationMode,
    failurePolicy,
    scheduledStartAtUtc: null,
    actualStartSkewMs: null,
    maxStartShiftMs: null,
    status: 'created',
    error: null
  })

  for (const target of targets) {
    store.patchRobotState(target.robotId, {
      status: 'idle',
      readinessErrors: [],
      programId: undefined,
      prepareCommandId: undefined,
      commandId: undefined,
      message: 'Waiting for FactoryRun create...',
      startedAt: undefined,
      completedAt: undefined
    })
  }

  try {
    const createStartedAtMonotonicMs = performance.now()

    recordFactoryRunDiagnostic('factory.create.started', {
      details: {
        targetCount: targets.length,
        coordinationMode,
        failurePolicy
      }
    })
    const created = await createFactoryRun(
      context,
      {
        companyId,
        coordinationMode,
        failurePolicy,
        programName: program.projectName || program.fileName.replace(/\.lua$/i, ''),
        luaFileName: program.fileName,
        luaContent: program.luaContent,
        robotIds: targets.map((target) => target.robotId)
      },
      signal
    )

    attachFactoryRunDiagnosticId(created.id)

    recordFactoryRunDiagnostic('factory.create.completed', {
      factoryRunId: created.id,
      durationMs: performance.now() - createStartedAtMonotonicMs,
      details: {
        targetCount: targets.length,
        coordinationMode: created.coordinationMode,
        failurePolicy: created.failurePolicy
      }
    })

    applyFactoryRunResponse(created)
    const prepareStartedAtMonotonicMs = performance.now()

    recordFactoryRunDiagnostic('factory.prepare.started', {
      factoryRunId: created.id,
      details: {
        targetCount: targets.length
      }
    })

    const prepared = await prepareFactoryRun(context, created.id, signal)
    applyFactoryRunResponse(prepared)

    const ready = READY_FACTORY_RUN_STATUSES.has(prepared.status)
      ? prepared
      : await waitForFactoryRunStatus(context, created.id, READY_FACTORY_RUN_STATUSES, signal)

    recordFactoryRunDiagnostic('factory.prepare.completed', {
      factoryRunId: created.id,
      durationMs: performance.now() - prepareStartedAtMonotonicMs,
      details: {
        targetCount: targets.length,
        ready: ready.status === 'Ready'
      }
    })

    if (ready.status !== 'Ready') {
      throw new Error(ready.failureReason || 'Factory run did not become Ready.')
    }

    recordFactoryRunDiagnostic('factory.ready', {
      factoryRunId: created.id,
      details: {
        targetCount: targets.length
      }
    })

    const startRequestStartedAtMonotonicMs = performance.now()

    recordFactoryRunDiagnostic('factory.start-request.started', {
      factoryRunId: created.id
    })

    const started = await startFactoryRun(context, created.id, signal)

    recordFactoryRunDiagnostic('factory.start-request.completed', {
      factoryRunId: created.id,
      durationMs: performance.now() - startRequestStartedAtMonotonicMs,
      details: {
        backendStatus: started.status
      }
    })

    applyFactoryRunResponse(started)

    const finalRun = TERMINAL_FACTORY_RUN_STATUSES.has(started.status)
      ? started
      : await waitForFactoryRunStatus(context, created.id, TERMINAL_FACTORY_RUN_STATUSES, signal)

    applyFactoryRunResponse(finalRun)

    if (finalRun.status !== 'Completed' && finalRun.status !== 'PartiallyCompleted') {
      throw new Error(finalRun.failureReason || `Factory run ended with status ${finalRun.status}.`)
    }
    recordFactoryRunDiagnostic('factory.completed', {
      factoryRunId: created.id,
      details: {
        targetCount: targets.length,
        partiallyCompleted: finalRun.status === 'PartiallyCompleted',
        actualStartSkewMs: finalRun.actualStartSkewMs ?? null
      }
    })

    endFactoryRunDiagnosticSession()
  } catch (error) {
    const aborted = signal?.aborted === true
    const finalError = getAbortAwareError(error)
    recordFactoryRunDiagnostic(aborted ? 'factory.cancelled' : 'factory.failed', {
      details: {
        reasonCode: aborted ? 'user_or_signal_cancelled' : 'factory_run_failed'
      }
    })

    endFactoryRunDiagnosticSession()

    store.setRunMetadata({
      status: aborted ? 'cancelled' : 'failed',
      error: aborted ? 'Factory run was cancelled.' : finalError.message
    })

    if (!aborted) {
      throw finalError
    }
  } finally {
    store.setBusy(false)
  }
}

export async function cancelFactoryProgramV2(
  context: BackendFactoryRunContext,
  factoryRunId: string
): Promise<void> {
  const response = await cancelFactoryRun(context, factoryRunId)
  applyFactoryRunResponse(response)
}
