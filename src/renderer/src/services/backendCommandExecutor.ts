import { useRobotStore } from '../store/robotStore'
import type { JointAngles, TCPPose } from '../types/robot.types'
import type { PendingDeviceCommand } from '../types/backendDevice'
import { prepareMoveLForRobot, runMoveL, runMoveLForRobot } from './robotMotionRuntime'
import type { PreparedMoveLTrajectory } from './robotMotionRuntime'
import { runScheduledJointMotion } from './factoryMotionScheduler'
import { factoryRunStepCoordinator } from './factoryRunStepCoordinator'
import { FactoryRunLocalStartBarrierCoordinator } from './factoryRunLocalStartBarrier'
import {
  CommandExecutionCancelledError,
  beginCommandExecutionForRobot,
  cancelActiveCommandsForGroup,
  cancelActiveCommandForRobot,
  finishCommandExecutionForRobot,
  throwIfCommandCancelled
} from './commandExecutionRuntime'
import { recordFactoryRunDiagnostic } from './factoryRunDiagnostics'
import { BackendDeviceRequestError } from './backendDeviceClient'
import type { DeviceFactoryRunProgramArtifactResponse } from './backendDeviceClient'
import {
  latchRobotFault,
  reportSafetyFaultEvent,
  throwIfRobotMotionBlocked
} from './robotFaultRuntime'
const FACTORY_RUN_DEBUG =
  typeof window !== 'undefined' &&
  window.localStorage.getItem('syntwin.factoryRun.debug') === 'true'

const FACTORY_RUN_ARM_MAX_ATTEMPTS = 600
const FACTORY_RUN_ARM_MAX_WAIT_MS = 120_000
const FACTORY_RUN_ARM_POLL_INTERVAL_MS = 200
const FACTORY_RUN_ARM_RETRY_INITIAL_MS = 100
const FACTORY_RUN_ARM_RETRY_MAX_MS = 1_000
const FACTORY_RUN_MAX_STANDALONE_START_LATENESS_MS = 250
const FACTORY_RUN_MAX_ABSOLUTE_COHORT_LATENESS_MS = 2000
const FACTORY_RUN_HARD_MAX_ABSOLUTE_COHORT_LATENESS_MS = 30000
const FACTORY_RUN_LOCAL_COHORT_JOIN_TIMEOUT_MS = 2000

interface SharedFactoryRunBarrierWait {
  controller: AbortController
  consumerCount: number
  settled: boolean
  promise: Promise<FactoryRunArmResponse>
}

const sharedFactoryRunBarrierWaits = new Map<string, SharedFactoryRunBarrierWait>()

interface SharedFactoryRunProgramArtifactLoad {
  controller: AbortController
  consumerCount: number
  settled: boolean
  promise: Promise<RunProgramStep[]>
}

const factoryRunLocalStartBarrier = new FactoryRunLocalStartBarrierCoordinator({
  registerParticipant: (factoryRunId, participantId) =>
    factoryRunStepCoordinator.registerParticipant(factoryRunId, participantId),
  sealParticipants: (factoryRunId) => factoryRunStepCoordinator.sealParticipants(factoryRunId),
  abortRun: (factoryRunId, reason) => factoryRunStepCoordinator.abortRun(factoryRunId, reason),
  cancelExecutionGroup: (factoryRunId, reason) => {
    cancelActiveCommandsForGroup(factoryRunId, reason)
  },
  joinTimeoutMs: FACTORY_RUN_LOCAL_COHORT_JOIN_TIMEOUT_MS,
  maxAbsoluteLatenessMs: FACTORY_RUN_MAX_ABSOLUTE_COHORT_LATENESS_MS,
  hardMaxAbsoluteLatenessMs: FACTORY_RUN_HARD_MAX_ABSOLUTE_COHORT_LATENESS_MS,
  onReleased: FACTORY_RUN_DEBUG
    ? (event) => console.debug('[FactoryRun] local cohort released', event)
    : undefined
})

interface MoveJPayload {
  jointAngles: number[]
  speed?: number
  acc?: number
  trace?: TracePayload
}

interface MoveLPayload {
  tcpPose: TCPPose
  speed?: number
  acc?: number
  recordedJointAngles?: JointAngles
  trace?: TracePayload
}

interface TracePayload {
  groupId: string
  sampleIndex: number
  sampleCount: number
  segmentDurationMs: number
}

interface RotateJointPayload {
  jointIndex: number
  angle: number
  speed?: number
  acc?: number
}

interface SetDOPayload {
  doType: 'cabinet' | 'tool'
  doIndex: number
  doValue: 0 | 1
}

interface RunProgramStep {
  orderIndex: number
  stepType: string
  label?: string
  payload?: unknown
}

export interface FactoryRunProgramArtifactReference {
  contractVersion: number
  factoryRunProgramId: string
  compiledProgramHash: string
}

interface FactoryRunProgramArtifactPointer {
  factoryRunId: string
  targetId: string
  artifact: FactoryRunProgramArtifactReference
}

interface PreparedRunProgramExecution {
  estimatedStepDurationsMs: number[]
  moveLTrajectoriesByStepIndex: Map<number, PreparedMoveLTrajectory>
}

interface FactoryRunArmPayload {
  factoryRunId: string
  targetId: string
  coordinationMode: 'ParallelIndependent' | 'Synchronized'
  failurePolicy: 'IsolateTarget' | 'AbortExecutionGroup'
}

export interface FactoryRunArmResponse {
  isReady: boolean
  scheduledStartAtUtc?: string | null
  expectedParticipantCount: number
  stepDurationsMs?: number[] | null
}

export interface BackendCommandExecutionContext {
  loadFactoryRunProgramArtifact?: (
    factoryRunId: string,
    targetId: string,
    artifact: FactoryRunProgramArtifactReference,
    signal: AbortSignal
  ) => Promise<DeviceFactoryRunProgramArtifactResponse>

  armFactoryRunCommand?: (
    payload: FactoryRunArmPayload,
    estimatedStepDurationsMs: number[],
    signal: AbortSignal
  ) => Promise<FactoryRunArmResponse>

  reportFactoryRunStarted?: (
    payload: FactoryRunArmPayload,
    actualStartedAtUtc: string,
    signal: AbortSignal
  ) => Promise<void>
}

const MAX_FACTORY_RUN_PROGRAM_ARTIFACT_CACHE_ENTRIES = 32
const factoryRunProgramArtifactCache = new Map<string, SharedFactoryRunProgramArtifactLoad>()

export function clearFactoryRunProgramArtifactCache(): void {
  for (const sharedLoad of factoryRunProgramArtifactCache.values()) {
    if (!sharedLoad.settled) {
      sharedLoad.controller.abort()
    }
  }

  factoryRunProgramArtifactCache.clear()
}

export function clearFactoryCommandRuntime(): void {
  for (const sharedWait of sharedFactoryRunBarrierWaits.values()) {
    if (!sharedWait.settled) {
      sharedWait.controller.abort()
    }
  }

  sharedFactoryRunBarrierWaits.clear()
  factoryRunLocalStartBarrier.clear('SynTwin account signed out')
  factoryRunStepCoordinator.clear()
  clearFactoryRunProgramArtifactCache()
}

export interface CommandExecutionFailureMetadata {
  source: string
  stepIndex?: number
  stepOrderIndex?: number
  stepType?: string
  stepLabel?: string
  technicalMessage: string
}

export class CommandExecutionError extends Error {
  metadata: CommandExecutionFailureMetadata

  constructor(message: string, metadata: CommandExecutionFailureMetadata) {
    super(message)
    this.name = 'CommandExecutionError'
    this.metadata = metadata
  }
}

export function getCommandExecutionFailureMetadata(
  error: unknown
): CommandExecutionFailureMetadata | null {
  return error instanceof CommandExecutionError ? error.metadata : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateMotionValue(value: unknown, fieldName: 'speed' | 'acc'): void {
  if (value !== undefined && (!isFiniteNumber(value) || value < 1 || value > 100)) {
    throw new Error(`${fieldName} must be between 1 and 100`)
  }
}

function parseTracePayload(value: unknown): TracePayload | undefined {
  if (value === undefined) return undefined

  if (!isRecord(value)) {
    throw new Error('Trace metadata must be an object')
  }

  if (
    typeof value.groupId !== 'string' ||
    !value.groupId.trim() ||
    !Number.isInteger(value.sampleIndex) ||
    !Number.isInteger(value.sampleCount) ||
    (value.sampleIndex as number) < 0 ||
    (value.sampleCount as number) < 1 ||
    (value.sampleIndex as number) >= (value.sampleCount as number) ||
    !isFiniteNumber(value.segmentDurationMs) ||
    value.segmentDurationMs < 0
  ) {
    throw new Error('Trace metadata is malformed')
  }

  return {
    groupId: value.groupId.trim(),
    sampleIndex: value.sampleIndex as number,
    sampleCount: value.sampleCount as number,
    segmentDurationMs: value.segmentDurationMs
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfCommandCancelled(signal)

  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      window.clearTimeout(timeoutId)
      signal.removeEventListener('abort', handleAbort)

      try {
        throwIfCommandCancelled(signal)
      } catch (error) {
        reject(error)
      }
    }

    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

function waitForAnimationFrame(signal: AbortSignal): Promise<number> {
  throwIfCommandCancelled(signal)

  return new Promise((resolve, reject) => {
    let frameId = 0

    const handleAbort = (): void => {
      window.cancelAnimationFrame(frameId)
      signal.removeEventListener('abort', handleAbort)

      try {
        throwIfCommandCancelled(signal)
      } catch (error) {
        reject(error)
      }
    }

    frameId = window.requestAnimationFrame((now) => {
      signal.removeEventListener('abort', handleAbort)
      resolve(now)
    })

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

function assertMotionCanContinue(signal: AbortSignal, robotId?: string): void {
  throwIfCommandCancelled(signal)
  throwIfRobotMotionBlocked(robotId)
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2
}

function getJointAnglesForRobot(robotId: string | undefined): JointAngles {
  const robotStore = useRobotStore.getState()

  if (!robotId) {
    return [...robotStore.jointAngles] as JointAngles
  }

  return [...(robotStore.jointAnglesByRobotId[robotId] ?? robotStore.jointAngles)] as JointAngles
}

function setJointAnglesForCommandRobot(robotId: string | undefined, angles: JointAngles): void {
  const robotStore = useRobotStore.getState()

  if (robotId) {
    robotStore.setJointAnglesForRobot(robotId, angles)
    return
  }

  robotStore.setJointAngles(angles)
}

function syncGlobalPlayingState(): void {
  const store = useRobotStore.getState()
  const hasRunningRobot = Object.values(store.robotExecutionById).some(
    (execution) => execution.isPlaying
  )

  store.setPlaying(hasRunningRobot)
}

function normalizeDurationOverride(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function setBackendRobotPlaying(robotId: string, isPlaying: boolean, lastError?: string): void {
  const store = useRobotStore.getState()

  store.setRobotExecution(robotId, {
    isPlaying,
    ...(isPlaying ? { startedAt: new Date().toISOString() } : {}),
    ...(lastError !== undefined ? { lastError } : {})
  })

  syncGlobalPlayingState()
}

function setBackendRobotStepIndex(robotId: string | undefined, index: number): void {
  const store = useRobotStore.getState()

  if (!robotId?.trim()) {
    store.setCurrentStepIndex(index)
    return
  }

  store.setRobotExecution(robotId, {
    currentStepIndex: index
  })

  if (store.selectedRobotId === robotId) {
    store.setCurrentStepIndex(index)
  }
}

function parseMoveJPayload(payload: unknown): MoveJPayload {
  if (!isRecord(payload)) {
    throw new Error('MoveJ payload must be an object')
  }

  const jointAngles = payload.jointAngles

  if (!Array.isArray(jointAngles)) {
    throw new Error('MoveJ jointAngles must be an array')
  }

  if (jointAngles.length !== 6) {
    throw new Error('MoveJ jointAngles must contain exactly 6 values')
  }

  if (!jointAngles.every(isFiniteNumber)) {
    throw new Error('Every MoveJ joint angle must be a finite number')
  }

  validateMotionValue(payload.speed, 'speed')
  validateMotionValue(payload.acc, 'acc')

  return {
    jointAngles,
    speed: payload.speed as number | undefined,
    acc: payload.acc as number | undefined,
    trace: parseTracePayload(payload.trace)
  }
}

function parseMoveLPayload(payload: unknown): MoveLPayload {
  if (!isRecord(payload)) {
    throw new Error('MoveL payload must be an object')
  }

  if (!isRecord(payload.tcpPose)) {
    throw new Error('MoveL tcpPose must be an object')
  }

  const tcpPose = payload.tcpPose
  const requiredFields = ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const

  for (const field of requiredFields) {
    if (!isFiniteNumber(tcpPose[field])) {
      throw new Error(`MoveL tcpPose.${field} must be a finite number`)
    }
  }

  validateMotionValue(payload.speed, 'speed')
  validateMotionValue(payload.acc, 'acc')

  const trace = parseTracePayload(payload.trace)
  let recordedJointAngles: JointAngles | undefined

  if (payload.recordedJointAngles !== undefined) {
    if (
      !Array.isArray(payload.recordedJointAngles) ||
      payload.recordedJointAngles.length !== 6 ||
      !payload.recordedJointAngles.every(isFiniteNumber)
    ) {
      throw new Error('MoveL recordedJointAngles must contain exactly 6 finite values')
    }

    recordedJointAngles = [...payload.recordedJointAngles] as JointAngles
  }

  if ((trace && !recordedJointAngles) || (!trace && recordedJointAngles)) {
    throw new Error('MoveL trace and recordedJointAngles must be provided together')
  }

  return {
    tcpPose: {
      x: tcpPose.x as number,
      y: tcpPose.y as number,
      z: tcpPose.z as number,
      rx: tcpPose.rx as number,
      ry: tcpPose.ry as number,
      rz: tcpPose.rz as number
    },
    speed: payload.speed as number | undefined,
    acc: payload.acc as number | undefined,
    recordedJointAngles,
    trace
  }
}

function parseRotateJointPayload(payload: unknown): RotateJointPayload {
  if (!isRecord(payload)) {
    throw new Error('RotateJoint payload must be an object')
  }

  if (
    !Number.isInteger(payload.jointIndex) ||
    (payload.jointIndex as number) < 0 ||
    (payload.jointIndex as number) > 5
  ) {
    throw new Error('RotateJoint jointIndex must be between 0 and 5')
  }

  if (!isFiniteNumber(payload.angle)) {
    throw new Error('RotateJoint angle must be a finite number')
  }

  validateMotionValue(payload.speed, 'speed')
  validateMotionValue(payload.acc, 'acc')

  return {
    jointIndex: payload.jointIndex as number,
    angle: payload.angle,
    speed: payload.speed as number | undefined,
    acc: payload.acc as number | undefined
  }
}

function parseSetDOPayload(payload: unknown): SetDOPayload {
  if (!isRecord(payload)) {
    throw new Error('SetDO payload must be an object')
  }

  if (payload.doType !== 'cabinet' && payload.doType !== 'tool') {
    throw new Error('SetDO doType must be cabinet or tool')
  }

  if (!Number.isInteger(payload.doIndex)) {
    throw new Error('SetDO doIndex must be an integer')
  }

  const doIndex = payload.doIndex as number

  if (payload.doType === 'cabinet' && (doIndex < 1 || doIndex > 8)) {
    throw new Error('Cabinet DO index must be between 1 and 8')
  }

  if (payload.doType === 'tool' && (doIndex < 0 || doIndex > 1)) {
    throw new Error('Tool DO index must be between 0 and 1')
  }

  if (payload.doValue !== 0 && payload.doValue !== 1) {
    throw new Error('SetDO doValue must be 0 or 1')
  }

  return {
    doType: payload.doType,
    doIndex,
    doValue: payload.doValue
  }
}

function parseRunProgramStepArray(rawSteps: unknown, source: string): RunProgramStep[] {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error(`${source} steps must be a non-empty array`)
  }

  const orderIndexes = new Set<number>()

  const steps = rawSteps.map((value, index): RunProgramStep => {
    if (!isRecord(value)) {
      throw new Error(`${source} step ${index + 1} must be an object`)
    }

    if (!Number.isInteger(value.orderIndex) || (value.orderIndex as number) < 1) {
      throw new Error(`${source} step ${index + 1} has invalid orderIndex`)
    }

    const orderIndex = value.orderIndex as number

    if (orderIndexes.has(orderIndex)) {
      throw new Error(`Duplicate ${source} orderIndex: ${orderIndex}`)
    }

    orderIndexes.add(orderIndex)

    if (typeof value.stepType !== 'string' || !value.stepType.trim()) {
      throw new Error(`${source} step ${orderIndex} requires stepType`)
    }

    return {
      orderIndex,
      stepType: value.stepType,
      label: typeof value.label === 'string' ? value.label : undefined,
      payload: value.payload
    }
  })

  return steps.sort((first, second) => first.orderIndex - second.orderIndex)
}

function parseRunProgramSteps(payload: unknown): RunProgramStep[] {
  if (!isRecord(payload)) {
    throw new Error('RunProgram payload must be an object')
  }

  return parseRunProgramStepArray(payload.steps, 'RunProgram')
}

function parseFactoryRunProgramArtifactPointer(
  payload: unknown
): FactoryRunProgramArtifactPointer | null {
  if (!isRecord(payload) || payload.artifact === undefined || payload.artifact === null) {
    return null
  }

  if (!isRecord(payload.artifact)) {
    throw new Error('Factory Run program artifact reference must be an object')
  }

  const factoryRunId = typeof payload.factoryRunId === 'string' ? payload.factoryRunId.trim() : ''
  const targetId = typeof payload.targetId === 'string' ? payload.targetId.trim() : ''
  const factoryRunProgramId =
    typeof payload.artifact.factoryRunProgramId === 'string'
      ? payload.artifact.factoryRunProgramId.trim()
      : ''
  const compiledProgramHash =
    typeof payload.artifact.compiledProgramHash === 'string'
      ? payload.artifact.compiledProgramHash.trim()
      : ''

  if (!factoryRunId || !targetId) {
    throw new Error('Factory Run program artifact requires factoryRunId and targetId')
  }

  if (payload.artifact.contractVersion !== 1) {
    throw new Error('Unsupported Factory Run program artifact contractVersion')
  }

  if (!factoryRunProgramId || !compiledProgramHash) {
    throw new Error(
      'Factory Run program artifact requires factoryRunProgramId and compiledProgramHash'
    )
  }

  return {
    factoryRunId,
    targetId,
    artifact: {
      contractVersion: 1,
      factoryRunProgramId,
      compiledProgramHash
    }
  }
}

function buildFactoryRunProgramArtifactCacheKey(pointer: FactoryRunProgramArtifactPointer): string {
  return (
    `${pointer.artifact.factoryRunProgramId}:` + pointer.artifact.compiledProgramHash.toLowerCase()
  )
}

function validateLoadedFactoryRunProgramArtifact(
  pointer: FactoryRunProgramArtifactPointer,
  artifact: DeviceFactoryRunProgramArtifactResponse
): RunProgramStep[] {
  if (
    artifact.factoryRunId !== pointer.factoryRunId ||
    artifact.targetId !== pointer.targetId ||
    artifact.factoryRunProgramId !== pointer.artifact.factoryRunProgramId ||
    artifact.contractVersion !== pointer.artifact.contractVersion ||
    artifact.compiledProgramHash.toLowerCase() !==
      pointer.artifact.compiledProgramHash.toLowerCase()
  ) {
    throw new Error('Loaded Factory Run program artifact does not match its command reference')
  }

  return parseRunProgramStepArray(artifact.steps, 'Factory Run program artifact')
}

function pruneFactoryRunProgramArtifactCache(): void {
  while (factoryRunProgramArtifactCache.size > MAX_FACTORY_RUN_PROGRAM_ARTIFACT_CACHE_ENTRIES) {
    const removableEntry = Array.from(factoryRunProgramArtifactCache.entries()).find(
      ([, sharedLoad]) => sharedLoad.settled && sharedLoad.consumerCount === 0
    )

    if (!removableEntry) return
    factoryRunProgramArtifactCache.delete(removableEntry[0])
  }
}

function getOrCreateFactoryRunProgramArtifactLoad(
  pointer: FactoryRunProgramArtifactPointer,
  context: BackendCommandExecutionContext
): SharedFactoryRunProgramArtifactLoad {
  const cacheKey = buildFactoryRunProgramArtifactCacheKey(pointer)
  const cached = factoryRunProgramArtifactCache.get(cacheKey)

  if (cached) {
    factoryRunProgramArtifactCache.delete(cacheKey)
    factoryRunProgramArtifactCache.set(cacheKey, cached)
    return cached
  }

  const controller = new AbortController()
  const sharedLoad: SharedFactoryRunProgramArtifactLoad = {
    controller,
    consumerCount: 0,
    settled: false,
    promise: Promise.resolve([])
  }

  sharedLoad.promise = context.loadFactoryRunProgramArtifact!(
    pointer.factoryRunId,
    pointer.targetId,
    pointer.artifact,
    controller.signal
  )
    .then((artifact) => validateLoadedFactoryRunProgramArtifact(pointer, artifact))
    .catch((error: unknown) => {
      if (factoryRunProgramArtifactCache.get(cacheKey) === sharedLoad) {
        factoryRunProgramArtifactCache.delete(cacheKey)
      }

      throw error
    })
    .finally(() => {
      sharedLoad.settled = true
      pruneFactoryRunProgramArtifactCache()
    })

  // All command consumers can be cancelled before the shared request observes its abort.
  // Keep a rejection handler attached so cleanup never creates an unhandled rejection.
  void sharedLoad.promise.catch(() => undefined)
  factoryRunProgramArtifactCache.set(cacheKey, sharedLoad)
  pruneFactoryRunProgramArtifactCache()
  return sharedLoad
}

function waitForFactoryRunProgramArtifactLoad(
  sharedPromise: Promise<RunProgramStep[]>,
  signal: AbortSignal
): Promise<RunProgramStep[]> {
  throwIfCommandCancelled(signal)

  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      signal.removeEventListener('abort', handleAbort)

      try {
        throwIfCommandCancelled(signal)
      } catch (error) {
        reject(error)
      }
    }

    signal.addEventListener('abort', handleAbort, { once: true })

    void sharedPromise.then(
      (steps) => {
        signal.removeEventListener('abort', handleAbort)

        try {
          throwIfCommandCancelled(signal)
          resolve(steps)
        } catch (error) {
          reject(error)
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort)
        reject(error)
      }
    )
  })
}

async function loadFactoryRunProgramArtifactSteps(
  pointer: FactoryRunProgramArtifactPointer,
  context: BackendCommandExecutionContext | undefined,
  signal: AbortSignal
): Promise<RunProgramStep[]> {
  if (!context?.loadFactoryRunProgramArtifact) {
    throw new Error('Factory Run program artifact loader is unavailable')
  }

  const cacheKey = buildFactoryRunProgramArtifactCacheKey(pointer)
  const sharedLoad = getOrCreateFactoryRunProgramArtifactLoad(pointer, context)
  sharedLoad.consumerCount += 1

  try {
    return await waitForFactoryRunProgramArtifactLoad(sharedLoad.promise, signal)
  } finally {
    sharedLoad.consumerCount = Math.max(0, sharedLoad.consumerCount - 1)

    if (sharedLoad.consumerCount === 0 && !sharedLoad.settled) {
      sharedLoad.controller.abort()

      if (factoryRunProgramArtifactCache.get(cacheKey) === sharedLoad) {
        factoryRunProgramArtifactCache.delete(cacheKey)
      }
    }
  }
}

async function resolveRunProgramSteps(
  payload: unknown,
  context: BackendCommandExecutionContext | undefined,
  signal: AbortSignal
): Promise<RunProgramStep[]> {
  if (isRecord(payload) && Array.isArray(payload.steps) && payload.steps.length > 0) {
    return parseRunProgramSteps(payload)
  }

  const artifactPointer = parseFactoryRunProgramArtifactPointer(payload)
  if (!artifactPointer) {
    throw new Error('RunProgram requires embedded steps or a program artifact reference')
  }

  return await loadFactoryRunProgramArtifactSteps(artifactPointer, context, signal)
}

function parseFactoryRunArmPayload(payload: unknown): FactoryRunArmPayload | null {
  if (!isRecord(payload)) return null

  const factoryRunId = typeof payload.factoryRunId === 'string' ? payload.factoryRunId : ''
  const targetId = typeof payload.targetId === 'string' ? payload.targetId : ''
  const syncMode = typeof payload.syncMode === 'string' ? payload.syncMode : ''
  const coordinationMode =
    payload.coordinationMode === 'ParallelIndependent'
      ? 'ParallelIndependent'
      : payload.coordinationMode === 'Synchronized' || syncMode === 'Barrier'
        ? 'Synchronized'
        : syncMode === 'Independent'
          ? 'ParallelIndependent'
          : null
  const failurePolicy =
    payload.failurePolicy === 'AbortExecutionGroup' ? 'AbortExecutionGroup' : 'IsolateTarget'

  if (!factoryRunId || !targetId || !coordinationMode) {
    return null
  }

  return {
    factoryRunId,
    targetId,
    coordinationMode,
    failurePolicy
  }
}

async function waitUntilScheduledStart(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  if (!isRecord(payload)) return
  if (typeof payload.scheduledStartAtUtc !== 'string') return

  const scheduledAt = Date.parse(payload.scheduledStartAtUtc)

  if (!Number.isFinite(scheduledAt)) return

  const now = Date.now()
  const delayMs = scheduledAt - now

  if (FACTORY_RUN_DEBUG) {
    console.debug('[FactoryRun] scheduled wait', {
      scheduledStartAtUtc: payload.scheduledStartAtUtc,
      nowUtc: new Date(now).toISOString(),
      delayMs: Math.round(delayMs)
    })
  }

  if (delayMs > 0) {
    await delay(delayMs, signal)
  }

  const readyAt = Date.now()
  const lateByMs = Math.max(0, readyAt - scheduledAt)

  if (lateByMs > FACTORY_RUN_MAX_STANDALONE_START_LATENESS_MS) {
    const reason =
      `Factory run missed its synchronized start by ${Math.round(lateByMs)} ms; ` +
      'all active commands were stopped to prevent timing skew.'

    console.error('[FactoryRun] synchronized start rejected', {
      scheduledStartAtUtc: payload.scheduledStartAtUtc,
      readyAtUtc: new Date(readyAt).toISOString(),
      lateByMs: Math.round(lateByMs)
    })

    if (robotId) {
      cancelActiveCommandForRobot(robotId, reason)
    }
    throwIfCommandCancelled(signal)
    throw new Error(reason)
  }

  if (delayMs <= 0 || lateByMs > 10) {
    console.warn('[FactoryRun] RunProgram arrived after scheduledStartAtUtc', {
      scheduledStartAtUtc: payload.scheduledStartAtUtc,
      readyAtUtc: new Date(readyAt).toISOString(),
      lateByMs: Math.round(lateByMs),
      toleratedLateStart: true
    })
  }

  assertMotionCanContinue(signal, robotId)
}

async function waitForFactoryRunBarrierStart(
  armPayload: FactoryRunArmPayload,
  estimatedStepDurationsMs: number[],
  context: BackendCommandExecutionContext | undefined,
  signal: AbortSignal,
  robotId?: string
): Promise<FactoryRunArmResponse> {
  if (!context?.armFactoryRunCommand) {
    throw new Error('FactoryRun barrier arm API is not available in command executor context.')
  }

  assertMotionCanContinue(signal, robotId)

  const registrationResponse = await requestFactoryRunArmWithRetry(
    armPayload,
    estimatedStepDurationsMs,
    context.armFactoryRunCommand,
    signal,
    'robot.arm.register'
  )

  if (registrationResponse.isReady && registrationResponse.scheduledStartAtUtc) {
    return registrationResponse
  }

  const sharedWait = getOrCreateSharedFactoryRunBarrierWait(
    armPayload,
    estimatedStepDurationsMs,
    context.armFactoryRunCommand
  )

  sharedWait.consumerCount += 1

  try {
    return await waitForSharedFactoryRunBarrierResult(sharedWait.promise, signal, robotId)
  } finally {
    sharedWait.consumerCount = Math.max(0, sharedWait.consumerCount - 1)

    if (sharedWait.consumerCount === 0 && !sharedWait.settled) {
      sharedWait.controller.abort()

      if (sharedFactoryRunBarrierWaits.get(armPayload.factoryRunId) === sharedWait) {
        sharedFactoryRunBarrierWaits.delete(armPayload.factoryRunId)
      }
    }
  }
}

async function requestFactoryRunArmWithRetry(
  armPayload: FactoryRunArmPayload,
  estimatedStepDurationsMs: number[],
  armFactoryRunCommand: NonNullable<BackendCommandExecutionContext['armFactoryRunCommand']>,
  signal: AbortSignal,
  diagnosticStage: 'robot.arm.register' | 'robot.arm.poll',
  deadlineAtMonotonicMs = performance.now() + FACTORY_RUN_ARM_MAX_WAIT_MS
): Promise<FactoryRunArmResponse> {
  let retryableFailureCount = 0

  for (let attempt = 0; attempt < FACTORY_RUN_ARM_MAX_ATTEMPTS; attempt++) {
    throwIfCommandCancelled(signal)

    const remainingBeforeRequestMs = deadlineAtMonotonicMs - performance.now()
    if (remainingBeforeRequestMs <= 0) {
      break
    }

    const requestStartedAtMonotonicMs = performance.now()

    let response: FactoryRunArmResponse

    try {
      response = await armFactoryRunCommand(armPayload, estimatedStepDurationsMs, signal)
    } catch (error) {
      if (signal.aborted) {
        throwIfCommandCancelled(signal)
      }

      if (isRetryableFactoryRunArmError(error)) {
        const exponentialDelayMs = Math.min(
          FACTORY_RUN_ARM_RETRY_MAX_MS,
          FACTORY_RUN_ARM_RETRY_INITIAL_MS * 2 ** Math.min(retryableFailureCount, 4)
        )
        const jitterMs = Math.floor(Math.random() * Math.max(1, exponentialDelayMs * 0.25))
        const retryDelayMs = Math.max(error.retryAfterMs ?? 0, exponentialDelayMs + jitterMs)
        const remainingMs = deadlineAtMonotonicMs - performance.now()

        recordFactoryRunDiagnostic('robot.arm.retry', {
          factoryRunId: armPayload.factoryRunId,
          targetId: armPayload.targetId,
          durationMs: performance.now() - requestStartedAtMonotonicMs,
          details: {
            attempt: attempt + 1,
            stage: diagnosticStage,
            errorCode: error.errorCode ?? 'legacy_factory_run_arm_busy',
            retryDelayMs
          }
        })

        if (remainingMs <= 0) {
          break
        }

        retryableFailureCount += 1
        await delay(Math.min(retryDelayMs, remainingMs), signal)
        continue
      }

      throw error
    }

    recordFactoryRunDiagnostic(diagnosticStage, {
      factoryRunId: armPayload.factoryRunId,
      targetId: armPayload.targetId,
      durationMs: performance.now() - requestStartedAtMonotonicMs,
      details: {
        attempt: attempt + 1,
        ready: response.isReady
      }
    })

    return response
  }

  throw new Error('FactoryRun arm request timed out while registering the robot.')
}

function getOrCreateSharedFactoryRunBarrierWait(
  armPayload: FactoryRunArmPayload,
  estimatedStepDurationsMs: number[],
  armFactoryRunCommand: NonNullable<BackendCommandExecutionContext['armFactoryRunCommand']>
): SharedFactoryRunBarrierWait {
  const existing = sharedFactoryRunBarrierWaits.get(armPayload.factoryRunId)
  if (existing) {
    return existing
  }

  const controller = new AbortController()
  const sharedWait: SharedFactoryRunBarrierWait = {
    controller,
    consumerCount: 0,
    settled: false,
    promise: Promise.resolve<FactoryRunArmResponse>({
      isReady: false,
      expectedParticipantCount: 0
    })
  }

  sharedWait.promise = pollFactoryRunBarrierUntilReady(
    armPayload,
    estimatedStepDurationsMs,
    armFactoryRunCommand,
    controller.signal
  ).finally(() => {
    sharedWait.settled = true

    if (sharedFactoryRunBarrierWaits.get(armPayload.factoryRunId) === sharedWait) {
      sharedFactoryRunBarrierWaits.delete(armPayload.factoryRunId)
    }
  })

  // The last consumer may be cancelled before the shared poller observes its abort.
  // Keep a rejection handler attached so that cleanup never creates an unhandled rejection.
  void sharedWait.promise.catch(() => undefined)
  sharedFactoryRunBarrierWaits.set(armPayload.factoryRunId, sharedWait)
  return sharedWait
}

async function pollFactoryRunBarrierUntilReady(
  armPayload: FactoryRunArmPayload,
  estimatedStepDurationsMs: number[],
  armFactoryRunCommand: NonNullable<BackendCommandExecutionContext['armFactoryRunCommand']>,
  signal: AbortSignal
): Promise<FactoryRunArmResponse> {
  const deadlineAtMonotonicMs = performance.now() + FACTORY_RUN_ARM_MAX_WAIT_MS

  for (let pollIndex = 0; pollIndex < FACTORY_RUN_ARM_MAX_ATTEMPTS; pollIndex++) {
    throwIfCommandCancelled(signal)

    if (performance.now() >= deadlineAtMonotonicMs) {
      break
    }

    const response = await requestFactoryRunArmWithRetry(
      armPayload,
      estimatedStepDurationsMs,
      armFactoryRunCommand,
      signal,
      'robot.arm.poll',
      deadlineAtMonotonicMs
    )

    if (response.isReady && response.scheduledStartAtUtc) {
      return response
    }

    const remainingMs = deadlineAtMonotonicMs - performance.now()
    if (remainingMs <= 0) {
      break
    }

    await delay(Math.min(FACTORY_RUN_ARM_POLL_INTERVAL_MS, remainingMs), signal)
  }

  throw new Error('FactoryRun barrier start timed out while waiting for all robots to arm.')
}

function waitForSharedFactoryRunBarrierResult(
  sharedPromise: Promise<FactoryRunArmResponse>,
  signal: AbortSignal,
  robotId?: string
): Promise<FactoryRunArmResponse> {
  assertMotionCanContinue(signal, robotId)

  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      signal.removeEventListener('abort', handleAbort)

      try {
        assertMotionCanContinue(signal, robotId)
      } catch (error) {
        reject(error)
      }
    }

    signal.addEventListener('abort', handleAbort, { once: true })

    void sharedPromise.then(
      (response) => {
        signal.removeEventListener('abort', handleAbort)

        try {
          assertMotionCanContinue(signal, robotId)
          resolve(response)
        } catch (error) {
          reject(error)
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort)
        reject(error)
      }
    )
  })
}

export function isRetryableFactoryRunArmError(error: unknown): error is BackendDeviceRequestError {
  if (!(error instanceof BackendDeviceRequestError)) {
    return false
  }

  if (error.errorCode === 'factory_run_arm_busy' && error.retryable) {
    return true
  }

  // Compatibility with an older Backend that returned this transient condition as HTTP 400.
  return error.status === 400 && /factory run barrier is busy/i.test(error.message)
}

async function executeWaitMs(
  payload: unknown,
  signal: AbortSignal,
  durationOverrideMs?: number,
  robotId?: string
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  if (!isRecord(payload)) {
    throw new Error('WaitMs payload must be an object')
  }

  const delayMs = payload.delayMs

  if (!Number.isInteger(delayMs) || (delayMs as number) < 0) {
    throw new Error('WaitMs delayMs must be a non-negative integer')
  }

  const finalDelayMs = normalizeDurationOverride(durationOverrideMs) ?? (delayMs as number)

  await delay(finalDelayMs, signal)
  assertMotionCanContinue(signal, robotId)
}

async function prepareRunProgramExecution(
  steps: RunProgramStep[],
  robotId: string | undefined,
  signal: AbortSignal
): Promise<PreparedRunProgramExecution> {
  const normalizedRobotId = robotId?.trim()

  if (!normalizedRobotId) {
    throw new Error('FactoryRun requires a robot ID before program preparation.')
  }

  const estimatedStepDurationsMs: number[] = []
  const moveLTrajectoriesByStepIndex = new Map<number, PreparedMoveLTrajectory>()

  // This state is advanced virtually while planning.
  // The real robot store is not changed during this phase.
  let plannedAngles = getJointAnglesForRobot(normalizedRobotId)
  let hasPlannedMotion = false
  const traceState: {
    active: { groupId: string; sampleCount: number; previousSampleIndex: number } | null
  } = { active: null }

  const validateTraceOrder = (trace: TracePayload, allowLegacyStartAtOne = false): void => {
    if (!traceState.active) {
      const isLegacyContinuation = allowLegacyStartAtOne && trace.sampleIndex === 1

      if (trace.sampleIndex !== 0 && !isLegacyContinuation) {
        throw new Error(
          `Trace ${trace.groupId} must start at sample 0, received ${trace.sampleIndex}`
        )
      }

      traceState.active = {
        groupId: trace.groupId,
        sampleCount: trace.sampleCount,
        previousSampleIndex: trace.sampleIndex
      }
    } else {
      if (
        trace.groupId !== traceState.active.groupId ||
        trace.sampleCount !== traceState.active.sampleCount ||
        trace.sampleIndex !== traceState.active.previousSampleIndex + 1
      ) {
        throw new Error(
          `Trace ${trace.groupId} samples are incomplete or out of order at ` +
            `${trace.sampleIndex}/${trace.sampleCount - 1}`
        )
      }

      traceState.active.previousSampleIndex = trace.sampleIndex
    }

    if (trace.sampleIndex === trace.sampleCount - 1) {
      traceState.active = null
    }
  }

  for (let index = 0; index < steps.length; index++) {
    assertMotionCanContinue(signal, normalizedRobotId)

    const step = steps[index]

    try {
      switch (step.stepType) {
        case 'MoveJ': {
          const moveJ = parseMoveJPayload(step.payload)
          const targetAngles = [...moveJ.jointAngles] as JointAngles

          if (moveJ.trace) {
            validateTraceOrder(moveJ.trace, hasPlannedMotion)
          }

          const maxDelta = Math.max(
            ...targetAngles.map((target, jointIndex) =>
              Math.abs(target - plannedAngles[jointIndex])
            )
          )

          const speedPercent = clamp(moveJ.speed ?? 30, 1, 100)

          estimatedStepDurationsMs.push(
            Math.round(clamp(800 + maxDelta * 18 * (30 / speedPercent), 800, 8000))
          )

          plannedAngles = [...targetAngles] as JointAngles
          hasPlannedMotion = true
          break
        }

        case 'RotateJoint': {
          const rotateJoint = parseRotateJointPayload(step.payload)
          const targetAngles = [...plannedAngles] as JointAngles

          const maxDelta = Math.abs(rotateJoint.angle - targetAngles[rotateJoint.jointIndex])

          targetAngles[rotateJoint.jointIndex] = rotateJoint.angle

          const speedPercent = clamp(rotateJoint.speed ?? 30, 1, 100)

          estimatedStepDurationsMs.push(
            Math.round(clamp(800 + maxDelta * 18 * (30 / speedPercent), 800, 8000))
          )

          plannedAngles = targetAngles
          break
        }

        case 'MoveL':
        case 'MoveTCP': {
          const moveL = parseMoveLPayload(step.payload)
          const speedPercent = clamp(moveL.speed ?? 30, 1, 100)

          if (moveL.trace) {
            validateTraceOrder(moveL.trace, hasPlannedMotion)
          }

          const trajectory = await prepareMoveLForRobot(
            normalizedRobotId,
            moveL.tcpPose,
            speedPercent,
            plannedAngles,
            signal,
            moveL.trace && moveL.recordedJointAngles
              ? {
                  recordedTargetAngles: moveL.recordedJointAngles,
                  segmentDurationMs: moveL.trace.segmentDurationMs,
                  trace: {
                    groupId: moveL.trace.groupId,
                    sampleIndex: moveL.trace.sampleIndex,
                    sampleCount: moveL.trace.sampleCount
                  }
                }
              : undefined
          )

          if (trajectory.keyframes.length < 2) {
            throw new Error(
              `Prepared ${step.stepType} trajectory does not contain motion keyframes.`
            )
          }

          moveLTrajectoriesByStepIndex.set(index, trajectory)

          plannedAngles = [...trajectory.keyframes[trajectory.keyframes.length - 1]] as JointAngles
          hasPlannedMotion = true

          const baseDurationMs =
            trajectory.durationMs ?? clamp(6000 * (30 / speedPercent), 3000, 12000)

          // Give the scheduler enough time to sample dense IK trajectories.
          const trajectoryDurationFloorMs = trajectory.waypointCount * 16

          estimatedStepDurationsMs.push(
            Math.round(Math.max(baseDurationMs, trajectoryDurationFloorMs))
          )

          break
        }

        case 'WaitMs': {
          if (!isRecord(step.payload)) {
            throw new Error('WaitMs payload must be an object')
          }

          const delayMs = step.payload.delayMs

          if (!Number.isInteger(delayMs) || (delayMs as number) < 0) {
            throw new Error('WaitMs delayMs must be a non-negative integer')
          }

          estimatedStepDurationsMs.push(delayMs as number)
          break
        }

        case 'SetDO':
          estimatedStepDurationsMs.push(100)
          break

        case 'GripperOpen':
        case 'GripperClose':
          estimatedStepDurationsMs.push(500)
          break

        case 'Comment':
          estimatedStepDurationsMs.push(0)
          break

        default:
          throw new Error(`Unsupported RunProgram step type during preparation: ${step.stepType}`)
      }
    } catch (error) {
      if (error instanceof CommandExecutionError) {
        throw error
      }

      const technicalMessage =
        error instanceof Error ? error.message : 'RunProgram preparation failed'

      throw new CommandExecutionError(technicalMessage, {
        source: 'RunProgramPreparation',
        stepIndex: index + 1,
        stepOrderIndex: step.orderIndex,
        stepType: step.stepType,
        stepLabel: step.label,
        technicalMessage
      })
    }
  }

  if (traceState.active) {
    throw new Error(
      `Trace ${traceState.active.groupId} ended at sample ` +
        `${traceState.active.previousSampleIndex}/${traceState.active.sampleCount - 1}`
    )
  }

  assertMotionCanContinue(signal, normalizedRobotId)

  return {
    estimatedStepDurationsMs,
    moveLTrajectoriesByStepIndex
  }
}

async function executeRunProgram(
  payload: unknown,
  signal: AbortSignal,
  robotId: string | undefined,
  context?: BackendCommandExecutionContext
): Promise<void> {
  const steps = await resolveRunProgramSteps(payload, context, signal)
  const armPayload = parseFactoryRunArmPayload(payload)
  const usesSynchronizedBarrier = armPayload?.coordinationMode === 'Synchronized'

  let barrierResponse: FactoryRunArmResponse | null = null
  let preparedProgramExecution: PreparedRunProgramExecution | null = null
  let stepStartedAtMonotonicMs: number | undefined
  let runCompletedSuccessfully = false

  try {
    if (armPayload) {
      const robotPreparationStartedAtMonotonicMs = performance.now()

      recordFactoryRunDiagnostic('robot.prepare.started', {
        factoryRunId: armPayload.factoryRunId,
        robotId,
        targetId: armPayload.targetId,
        details: {
          stepCount: steps.length
        }
      })

      try {
        preparedProgramExecution = await prepareRunProgramExecution(steps, robotId, signal)
      } catch (error) {
        recordFactoryRunDiagnostic('robot.prepare.failed', {
          factoryRunId: armPayload.factoryRunId,
          robotId,
          targetId: armPayload.targetId,
          durationMs: performance.now() - robotPreparationStartedAtMonotonicMs,
          details: {
            reasonCode: 'program_preparation_failed'
          }
        })

        throw error
      }

      recordFactoryRunDiagnostic('robot.prepare.completed', {
        factoryRunId: armPayload.factoryRunId,
        robotId,
        targetId: armPayload.targetId,
        durationMs: performance.now() - robotPreparationStartedAtMonotonicMs,
        details: {
          stepCount: steps.length,
          moveLStepCount: preparedProgramExecution.moveLTrajectoriesByStepIndex.size
        }
      })

      if (usesSynchronizedBarrier) {
        barrierResponse = await waitForFactoryRunBarrierStart(
          armPayload,
          preparedProgramExecution.estimatedStepDurationsMs,
          context,
          signal,
          robotId
        )

        const scheduledStartAtUtc = barrierResponse.scheduledStartAtUtc

        if (!scheduledStartAtUtc) {
          throw new Error(
            'Factory run barrier became ready without a synchronized start timestamp.'
          )
        }

        const cohortJoinedAtMonotonicMs = performance.now()

        recordFactoryRunDiagnostic('robot.cohort.joined', {
          factoryRunId: armPayload.factoryRunId,
          robotId,
          targetId: armPayload.targetId,
          details: {
            expectedParticipantCount: barrierResponse.expectedParticipantCount
          }
        })

        stepStartedAtMonotonicMs = await factoryRunLocalStartBarrier.waitForStart(
          armPayload.factoryRunId,
          armPayload.targetId,
          scheduledStartAtUtc,
          barrierResponse.expectedParticipantCount,
          signal,
          armPayload.failurePolicy
        )

        recordFactoryRunDiagnostic('robot.cohort.released', {
          factoryRunId: armPayload.factoryRunId,
          robotId,
          targetId: armPayload.targetId,
          durationMs: performance.now() - cohortJoinedAtMonotonicMs,
          details: {
            expectedParticipantCount: barrierResponse.expectedParticipantCount
          }
        })
      } else {
        // Independent targets start from their own monotonic clock. They never
        // register with the cohort or step coordinators.
        stepStartedAtMonotonicMs = performance.now()
        recordFactoryRunDiagnostic('robot.independent.ready', {
          factoryRunId: armPayload.factoryRunId,
          robotId,
          targetId: armPayload.targetId
        })
      }
    } else {
      // A direct/single-robot RunProgram must use the same preflight as a
      // Factory target. This keeps recorded traces out of the fallback IK path
      // and ensures a program cannot fail halfway through preparation.
      preparedProgramExecution = await prepareRunProgramExecution(steps, robotId, signal)
      await waitUntilScheduledStart(payload, signal, robotId)
    }

    const sharedStepDurationsMs = Array.isArray(barrierResponse?.stepDurationsMs)
      ? barrierResponse.stepDurationsMs
      : []

    const preparedMoveLTrajectoriesByStepIndex =
      preparedProgramExecution?.moveLTrajectoriesByStepIndex ??
      new Map<number, PreparedMoveLTrajectory>()

    if (FACTORY_RUN_DEBUG && armPayload) {
      console.debug('[FactoryRun] program prepared before factory execution', {
        robotId,
        factoryRunId: armPayload.factoryRunId,
        coordinationMode: armPayload.coordinationMode,
        preparedMoveLStepCount: preparedMoveLTrajectoriesByStepIndex.size,
        estimatedStepDurationsMs: preparedProgramExecution?.estimatedStepDurationsMs ?? [],
        sharedStepDurationsMs
      })
    }

    const actualStartedAtUtc = new Date().toISOString()

    recordFactoryRunDiagnostic('robot.run.started', {
      factoryRunId: armPayload?.factoryRunId ?? null,
      robotId,
      targetId: armPayload?.targetId,
      details: {
        barrier: usesSynchronizedBarrier,
        coordinationMode: armPayload?.coordinationMode ?? null
      }
    })

    setBackendRobotPlaying(robotId ?? '', true, '')

    // Start metrics must not delay the first motion frame.
    if (armPayload && context?.reportFactoryRunStarted) {
      void context
        .reportFactoryRunStarted(armPayload, actualStartedAtUtc, signal)
        .catch((error) => {
          if (FACTORY_RUN_DEBUG) {
            console.warn('[FactoryRun] actual-start report failed', {
              robotId,
              actualStartedAtUtc,
              error
            })
          }
        })
    }

    if (FACTORY_RUN_DEBUG) {
      console.debug('[FactoryRun] RunProgram started', {
        robotId,
        startedAtUtc: actualStartedAtUtc,
        barrier: usesSynchronizedBarrier,
        coordinationMode: armPayload?.coordinationMode ?? null
      })
    }

    for (let index = 0; index < steps.length; index++) {
      assertMotionCanContinue(signal, robotId)

      const step = steps[index]
      const stepStartedAtDiagnosticMs = performance.now()

      recordFactoryRunDiagnostic('robot.step.started', {
        factoryRunId: armPayload?.factoryRunId ?? null,
        robotId,
        targetId: armPayload?.targetId,
        stepIndex: index,
        details: {
          orderIndex: step.orderIndex,
          stepType: step.stepType
        }
      })
      const sharedDurationMs = normalizeDurationOverride(sharedStepDurationsMs[index])

      setBackendRobotStepIndex(robotId, index)

      try {
        const requiresSharedMotionDuration =
          step.stepType === 'MoveJ' ||
          step.stepType === 'MoveL' ||
          step.stepType === 'MoveTCP' ||
          step.stepType === 'RotateJoint'

        if (
          usesSynchronizedBarrier &&
          requiresSharedMotionDuration &&
          sharedDurationMs === undefined
        ) {
          throw new Error(
            `FactoryRun step ${step.orderIndex} (${step.stepType}) ` +
              `does not have a shared motion duration.`
          )
        }

        switch (step.stepType) {
          case 'MoveJ':
            await executeMoveJ(
              step.payload,
              signal,
              robotId,
              sharedDurationMs,
              stepStartedAtMonotonicMs
            )
            break

          case 'MoveL': {
            const preparedTrajectory = preparedMoveLTrajectoriesByStepIndex.get(index)

            if (preparedProgramExecution && !preparedTrajectory) {
              throw new Error(
                `FactoryRun MoveL step ${step.orderIndex} ` + `does not have a prepared trajectory.`
              )
            }

            await executeMoveL(
              step.payload,
              signal,
              robotId,
              sharedDurationMs,
              stepStartedAtMonotonicMs,
              preparedTrajectory
            )
            break
          }
          case 'RotateJoint':
            await executeRotateJoint(
              step.payload,
              signal,
              robotId,
              sharedDurationMs,
              stepStartedAtMonotonicMs
            )
            break

          case 'MoveTCP': {
            const preparedTrajectory = preparedMoveLTrajectoriesByStepIndex.get(index)

            if (preparedProgramExecution && !preparedTrajectory) {
              throw new Error(
                `FactoryRun MoveTCP step ${step.orderIndex} ` +
                  `does not have a prepared trajectory.`
              )
            }

            await executeMoveTCP(
              step.payload,
              signal,
              robotId,
              sharedDurationMs,
              stepStartedAtMonotonicMs,
              preparedTrajectory
            )
            break
          }

          case 'WaitMs':
            await executeWaitMs(step.payload, signal, sharedDurationMs, robotId)
            break

          case 'SetDO':
            await executeSetDO(step.payload, signal, robotId)
            break

          case 'GripperOpen':
            await executeGripper('open', signal, robotId)
            break

          case 'GripperClose':
            await executeGripper('closed', signal, robotId)
            break

          case 'Comment':
            break

          default:
            throw new Error(`Unsupported RunProgram step type: ${step.stepType}`)
        }
        assertMotionCanContinue(signal, robotId)
        recordFactoryRunDiagnostic('robot.step.completed', {
          factoryRunId: armPayload?.factoryRunId ?? null,
          robotId,
          targetId: armPayload?.targetId,
          stepIndex: index,
          durationMs: performance.now() - stepStartedAtDiagnosticMs,
          details: {
            orderIndex: step.orderIndex,
            stepType: step.stepType
          }
        })

        if (armPayload && usesSynchronizedBarrier) {
          const stepBarrierResult = await factoryRunStepCoordinator.arriveAtStep({
            factoryRunId: armPayload.factoryRunId,
            participantId: armPayload.targetId,
            stepIndex: index,
            completedAtMonotonicMs: performance.now(),
            signal
          })
          stepStartedAtMonotonicMs = stepBarrierResult.nextStepStartedAtMonotonicMs

          if (FACTORY_RUN_DEBUG) {
            console.debug('[FactoryRun] step barrier released', {
              factoryRunId: armPayload.factoryRunId,
              targetId: armPayload.targetId,
              robotId,
              stepIndex: index,
              stepOrderIndex: step.orderIndex,
              participantCount: stepBarrierResult.participantCount,
              completionSkewMs: Math.round(stepBarrierResult.completionSkewMs),
              nextStepStartedAtMonotonicMs: stepBarrierResult.nextStepStartedAtMonotonicMs
            })
          }
        }
      } catch (error) {
        if (error instanceof CommandExecutionError) {
          throw error
        }

        const technicalMessage =
          error instanceof Error ? error.message : 'RunProgram step execution failed'

        throw new CommandExecutionError(technicalMessage, {
          source: 'RunProgram',
          stepIndex: index + 1,
          stepOrderIndex: step.orderIndex,
          stepType: step.stepType,
          stepLabel: step.label,
          technicalMessage
        })
      }
    }

    assertMotionCanContinue(signal, robotId)
    recordFactoryRunDiagnostic('robot.run.completed', {
      factoryRunId: armPayload?.factoryRunId ?? null,
      robotId,
      targetId: armPayload?.targetId,
      details: {
        stepCount: steps.length
      }
    })
    runCompletedSuccessfully = true
  } catch (error) {
    if (armPayload) {
      const coordinatorError =
        error instanceof Error ? error : new Error('Factory run execution failed.')
      const reason = `Factory run ${armPayload.factoryRunId}: ${coordinatorError.message}`

      if (armPayload.failurePolicy === 'IsolateTarget') {
        let activeParticipantCount: number | null = null

        if (usesSynchronizedBarrier) {
          factoryRunLocalStartBarrier.dropParticipant(
            armPayload.factoryRunId,
            armPayload.targetId,
            reason
          )
          activeParticipantCount = factoryRunStepCoordinator.dropParticipant(
            armPayload.factoryRunId,
            armPayload.targetId,
            coordinatorError
          )
        }

        if (robotId) {
          cancelActiveCommandForRobot(robotId, reason)
        }

        recordFactoryRunDiagnostic('robot.participant.dropped', {
          factoryRunId: armPayload.factoryRunId,
          robotId,
          targetId: armPayload.targetId,
          details: {
            activeParticipantCount,
            failurePolicy: armPayload.failurePolicy,
            coordinationMode: armPayload.coordinationMode
          }
        })
      } else {
        if (usesSynchronizedBarrier) {
          factoryRunStepCoordinator.abortRun(armPayload.factoryRunId, coordinatorError)
        }
        cancelActiveCommandsForGroup(armPayload.factoryRunId, reason)
      }
    }
    recordFactoryRunDiagnostic('robot.run.failed', {
      factoryRunId: armPayload?.factoryRunId ?? null,
      robotId,
      targetId: armPayload?.targetId,
      details: {
        reasonCode: 'command_execution_failed'
      }
    })

    throw error
  } finally {
    if (armPayload && usesSynchronizedBarrier && runCompletedSuccessfully) {
      factoryRunStepCoordinator.completeParticipant(armPayload.factoryRunId, armPayload.targetId)
    }
  }
}

async function executeMoveJ(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string,
  durationOverrideMs?: number,
  startedAtMonotonicMs?: number
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  const moveJ = parseMoveJPayload(payload)
  const startAngles = getJointAnglesForRobot(robotId)
  const targetAngles = [...moveJ.jointAngles]

  const maxDelta = Math.max(
    ...targetAngles.map((target, index) => Math.abs(target - startAngles[index]))
  )

  const speedPercent = moveJ.speed ?? 30
  const estimatedDurationMs = clamp(800 + maxDelta * 18 * (30 / speedPercent), 800, 8000)
  const durationMs = normalizeDurationOverride(durationOverrideMs) ?? estimatedDurationMs

  if (FACTORY_RUN_DEBUG) {
    console.debug('[FactoryRun] MoveJ timing', {
      robotId,
      maxDelta,
      speedPercent,
      estimatedDurationMs: Math.round(estimatedDurationMs),
      durationMs: Math.round(durationMs),
      usingSharedDuration: normalizeDurationOverride(durationOverrideMs) !== undefined
    })
  }
  if (robotId?.trim()) {
    await runScheduledJointMotion(
      robotId,
      startAngles,
      targetAngles as JointAngles,
      durationMs,
      signal,
      easeInOutCubic,
      startedAtMonotonicMs
    )
  } else {
    // Giữ hành vi cũ cho command không gắn robot cụ thể.
    const startedAt = performance.now()

    while (true) {
      assertMotionCanContinue(signal, robotId)

      const now = performance.now()
      const rawProgress = (now - startedAt) / durationMs
      const progress = clamp(rawProgress, 0, 1)
      const easedProgress = easeInOutCubic(progress)

      const interpolated = startAngles.map((start, index) => {
        const target = targetAngles[index]
        return start + (target - start) * easedProgress
      }) as JointAngles

      setJointAnglesForCommandRobot(robotId, interpolated)

      if (progress >= 1) {
        break
      }

      await waitForAnimationFrame(signal)
    }
  }

  setJointAnglesForCommandRobot(robotId, targetAngles as JointAngles)

  assertMotionCanContinue(signal, robotId)

  setJointAnglesForCommandRobot(robotId, targetAngles as JointAngles)

  assertMotionCanContinue(signal, robotId)
}

async function executeRotateJoint(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string,
  durationOverrideMs?: number,
  startedAtMonotonicMs?: number
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  const rotateJoint = parseRotateJointPayload(payload)
  const targetAngles = getJointAnglesForRobot(robotId)

  targetAngles[rotateJoint.jointIndex] = rotateJoint.angle

  await executeMoveJ(
    {
      jointAngles: targetAngles,
      speed: rotateJoint.speed,
      acc: rotateJoint.acc
    },
    signal,
    robotId,
    durationOverrideMs,
    startedAtMonotonicMs
  )
}

async function executeMoveL(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string,
  durationOverrideMs?: number,
  startedAtMonotonicMs?: number,
  preparedTrajectory?: PreparedMoveLTrajectory
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  const moveL = parseMoveLPayload(payload)

  if (robotId?.trim()) {
    await runMoveLForRobot(robotId, moveL.tcpPose, moveL.speed ?? 30, signal, {
      managePlayingState: false,
      durationMs: durationOverrideMs,
      startedAtMonotonicMs,
      preparedTrajectory
    })
  } else {
    if (preparedTrajectory) {
      throw new Error('Prepared MoveL trajectory requires a robot-specific runner.')
    }

    await runMoveL(moveL.tcpPose, moveL.speed ?? 30, signal, {
      managePlayingState: false,
      durationMs: durationOverrideMs,
      startedAtMonotonicMs
    })
  }

  assertMotionCanContinue(signal, robotId)
}

async function executeMoveTCP(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string,
  durationOverrideMs?: number,
  startedAtMonotonicMs?: number,
  preparedTrajectory?: PreparedMoveLTrajectory
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  await executeMoveL(
    payload,
    signal,
    robotId,
    durationOverrideMs,
    startedAtMonotonicMs,
    preparedTrajectory
  )
}
async function executeSetDO(
  payload: unknown,
  signal: AbortSignal,
  robotId?: string
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  const setDO = parseSetDOPayload(payload)

  useRobotStore.getState().setDigitalOutput(setDO.doType, setDO.doIndex, setDO.doValue)

  await delay(100, signal)
  assertMotionCanContinue(signal, robotId)
}

async function executeGripper(
  state: 'open' | 'closed',
  signal: AbortSignal,
  robotId?: string
): Promise<void> {
  assertMotionCanContinue(signal, robotId)

  const robotStore = useRobotStore.getState()
  const doValue: 0 | 1 = state === 'closed' ? 1 : 0

  robotStore.setDigitalOutput('cabinet', 1, doValue)
  robotStore.setGripperState(state)

  await delay(500, signal)
  assertMotionCanContinue(signal, robotId)
}

function executeEmergencyStop(robotId: string, commandId: string): void {
  const resolution = reportSafetyFaultEvent({
    type: 'global-estop',
    rootRobotIds: [robotId],
    stopScope: 'All',
    code: 'GLOBAL_ESTOP',
    message: `Global emergency stop requested by command ${commandId}.`
  })

  const store = useRobotStore.getState()

  for (const stoppedRobotId of resolution.stopRobotIds) {
    store.setRobotExecution(stoppedRobotId, {
      isPlaying: false,
      currentStepIndex: 0
    })
  }

  syncGlobalPlayingState()
}
export async function executeBackendCommand(
  command: PendingDeviceCommand,
  context?: BackendCommandExecutionContext
): Promise<void> {
  if (command.commandType === 'EStop') {
    executeEmergencyStop(command.robotId, command.commandId)
    return
  }

  const factoryRunPayload =
    command.commandType === 'RunProgram' ? parseFactoryRunArmPayload(command.payload) : null
  const signal = beginCommandExecutionForRobot(
    command.robotId,
    command.commandId,
    factoryRunPayload?.factoryRunId,
    factoryRunPayload?.failurePolicy
  )

  if (command.commandType !== 'RunProgram') {
    setBackendRobotPlaying(command.robotId, true, '')
  }

  try {
    assertMotionCanContinue(signal, command.robotId)

    switch (command.commandType) {
      case 'PrepareProgram':
        {
          const artifactPointer = parseFactoryRunProgramArtifactPointer(command.payload)
          if (artifactPointer) {
            await loadFactoryRunProgramArtifactSteps(artifactPointer, context, signal)
          } else {
            // Preserve the legacy preparation behavior for existing command rows.
            await delay(200, signal)
          }
        }
        break

      case 'SetDO':
        await executeSetDO(command.payload, signal, command.robotId)
        break

      case 'MoveJ':
        await executeMoveJ(command.payload, signal, command.robotId)
        break

      case 'MoveL':
        await executeMoveL(command.payload, signal, command.robotId)
        break

      case 'RunProgram':
        await executeRunProgram(command.payload, signal, command.robotId, context)
        break

      default:
        throw new Error(`Unsupported command type: ${command.commandType}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backend command execution failed'

    useRobotStore.getState().setRobotExecution(command.robotId, {
      lastError: message
    })

    if (!(error instanceof CommandExecutionCancelledError)) {
      latchRobotFault(command.robotId, {
        kind: 'command',
        code: 'COMMAND_EXECUTION_FAILED',
        message,
        cancelMotion: false
      })
    }

    throw error
  } finally {
    setBackendRobotPlaying(command.robotId, false)

    finishCommandExecutionForRobot(command.robotId, command.commandId)
  }
}
