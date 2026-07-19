import { create } from 'zustand'
import {
  DEFAULT_JOINT_ANGLES,
  JointAngles,
  ProgrammingMode,
  TCPPose,
  RobotProgramSource,
  RobotInstance,
  RobotSceneBinding,
  WorkflowStep
} from '../types/robot.types'
import type { BackendSimulatorStatus } from '../types/backendDevice'
import type { CartesianInteractionMode } from '../types/cartesianTrace.types'
export type WorkspaceMode = 'factory' | 'train'
export type RobotPlacementTransformMode = 'translate' | 'rotate'

const TRAINING_VIEW_STATE_STORAGE_KEY = 'fai.trainingViewState.v1'

interface PersistedTrainingViewState {
  workspaceMode: WorkspaceMode
  jointAngles: JointAngles
  selectedRobotId: string | null
}

function isPersistedJointAngles(value: unknown): value is JointAngles {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    value.every(
      (angle) => typeof angle === 'number' && Number.isFinite(angle) && Math.abs(angle) <= 360
    )
  )
}

function loadPersistedTrainingViewState(): PersistedTrainingViewState {
  const fallback: PersistedTrainingViewState = {
    workspaceMode: 'factory',
    jointAngles: [...DEFAULT_JOINT_ANGLES],
    selectedRobotId: null
  }

  if (typeof window === 'undefined') return fallback

  try {
    const raw = window.localStorage.getItem(TRAINING_VIEW_STATE_STORAGE_KEY)
    if (!raw) return fallback

    const value = JSON.parse(raw) as Partial<PersistedTrainingViewState>
    return {
      workspaceMode: value.workspaceMode === 'train' ? 'train' : 'factory',
      jointAngles: isPersistedJointAngles(value.jointAngles)
        ? [...value.jointAngles]
        : fallback.jointAngles,
      selectedRobotId:
        typeof value.selectedRobotId === 'string' && value.selectedRobotId.trim()
          ? value.selectedRobotId.trim()
          : null
    }
  } catch {
    return fallback
  }
}

let persistedTrainingViewState = loadPersistedTrainingViewState()
let persistTrainingViewStateTimer: ReturnType<typeof setTimeout> | null = null

function flushPersistedTrainingViewState(): void {
  if (typeof window === 'undefined') return

  if (persistTrainingViewStateTimer !== null) {
    clearTimeout(persistTrainingViewStateTimer)
    persistTrainingViewStateTimer = null
  }

  try {
    window.localStorage.setItem(
      TRAINING_VIEW_STATE_STORAGE_KEY,
      JSON.stringify(persistedTrainingViewState)
    )
  } catch {
    // Storage can be unavailable in privacy-restricted renderer sessions.
  }
}

function persistTrainingViewState(patch: Partial<PersistedTrainingViewState>): void {
  persistedTrainingViewState = {
    ...persistedTrainingViewState,
    ...patch,
    jointAngles: patch.jointAngles ? [...patch.jointAngles] : persistedTrainingViewState.jointAngles
  }

  if (typeof window === 'undefined') return
  if (persistTrainingViewStateTimer !== null) clearTimeout(persistTrainingViewStateTimer)
  persistTrainingViewStateTimer = setTimeout(flushPersistedTrainingViewState, 120)
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPersistedTrainingViewState)
}

export interface RobotExecutionState {
  isPlaying: boolean
  currentStepIndex: number
  startedAt?: string
  lastError?: string
}
const DEFAULT_TCP_POSE: TCPPose = {
  x: 0,
  y: 0,
  z: 0,
  rx: 0,
  ry: 0,
  rz: 0
}
function createStepId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `step_${crypto.randomUUID()}`
  }

  return `step_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

interface RobotState {
  // Robot Hardware Config & Current values
  // Backend robot instances. This is a light multi-robot foundation;
  // current motion/workflow state remains single-active-robot for now.
  robots: RobotInstance[]
  selectedRobotId: string | null
  workspaceMode: WorkspaceMode
  robotRuntimeById: Record<string, BackendSimulatorStatus>
  robotExecutionById: Record<string, RobotExecutionState>
  robotModel: string
  jointAngles: JointAngles
  jointAnglesByRobotId: Record<string, JointAngles>
  tcpPoseByRobotId: Record<string, TCPPose>
  tcpPose: TCPPose
  isIKMode: boolean
  cartesianInteractionMode: CartesianInteractionMode
  isRobotPlacementMode: boolean
  robotPlacementTransformMode: RobotPlacementTransformMode
  // Project properties
  projectName: string
  currentFilePath: string | null
  programSource: RobotProgramSource

  // Workflow Steps
  steps: WorkflowStep[]
  selectedStepId: string | null

  // Simulation State
  isPlaying: boolean
  selectedJointName: string | null
  playbackSpeed: number // multiplier (1 = 1x, 2 = 2x, etc.)
  currentStepIndex: number
  mode: ProgrammingMode
  language: 'vi' | 'en'
  lengthUnit: 'mm' | 'm'
  angleUnit: 'deg' | 'rad'
  // Simulated robot I/O
  cabinetDigitalOutputs: Record<number, 0 | 1>
  toolDigitalOutputs: Record<number, 0 | 1>
  gripperState: 'open' | 'closed'

  // Actions
  setRobots: (robots: RobotInstance[]) => void
  upsertRobot: (robot: RobotInstance) => void
  removeRobot: (robotId: string) => void
  updateRobotSceneBinding: (robotId: string, sceneBinding: RobotSceneBinding) => void
  selectRobot: (robotId: string | null) => void
  setWorkspaceMode: (mode: WorkspaceMode) => void
  setRobotExecution: (robotId: string, execution: Partial<RobotExecutionState>) => void
  clearRobotExecution: (robotId: string) => void
  clearAllRobotExecutions: () => void
  setRobotRuntime: (robotId: string, status: Partial<BackendSimulatorStatus>) => void
  clearRobotRuntime: (robotId: string) => void
  clearAllRobotRuntime: () => void
  setJointAngles: (angles: JointAngles) => void
  setJointAnglesForRobot: (robotId: string, angles: JointAngles) => void
  setJointAnglesForRobots: (patch: Record<string, JointAngles>) => void

  setTCPPose: (pose: TCPPose) => void
  setTCPPoseForRobot: (robotId: string, pose: TCPPose) => void
  setIKMode: (enabled: boolean) => void
  setCartesianInteractionMode: (mode: CartesianInteractionMode) => void
  setRobotPlacementMode: (enabled: boolean) => void
  setRobotPlacementTransformMode: (mode: RobotPlacementTransformMode) => void
  setProjectName: (name: string) => void
  setCurrentFilePath: (path: string | null) => void
  setMode: (mode: ProgrammingMode) => void
  setLanguage: (lang: 'vi' | 'en') => void
  setLengthUnit: (unit: 'mm' | 'm') => void
  setAngleUnit: (unit: 'deg' | 'rad') => void
  setDigitalOutput: (doType: 'cabinet' | 'tool', doIndex: number, doValue: 0 | 1) => void
  setProgramSource: (source: RobotProgramSource) => void

  setGripperState: (state: 'open' | 'closed') => void
  // Workflow actions
  addStep: (step: Omit<WorkflowStep, 'id'>) => void
  addSteps: (steps: Omit<WorkflowStep, 'id'>[]) => void
  removeStep: (id: string) => void
  clearSteps: () => void
  updateStep: (id: string, updated: Partial<WorkflowStep>) => void
  reorderSteps: (newSteps: WorkflowStep[]) => void
  setSelectedStepId: (id: string | null) => void

  // Simulation actions
  setPlaying: (playing: boolean) => void
  setPlaybackSpeed: (speed: number) => void
  setCurrentStepIndex: (index: number) => void
  resetSimulation: () => void
  setSelectedJointName: (name: string | null) => void
}

export const useRobotStore = create<RobotState>((set) => ({
  robots: [],
  selectedRobotId: null,
  workspaceMode: persistedTrainingViewState.workspaceMode,
  robotRuntimeById: {},
  robotExecutionById: {},
  robotModel: 'FR5',
  jointAngles: [...persistedTrainingViewState.jointAngles],
  jointAnglesByRobotId: {},
  tcpPoseByRobotId: {},
  tcpPose: { ...DEFAULT_TCP_POSE },
  isIKMode: false,
  cartesianInteractionMode: 'point',
  isRobotPlacementMode: false,
  robotPlacementTransformMode: 'translate',

  projectName: 'coffee_machine_workflow',
  currentFilePath: null,
  programSource: 'Studio',

  steps: [],
  selectedStepId: null,

  isPlaying: false,
  playbackSpeed: 1,
  currentStepIndex: 0,
  selectedJointName: null,
  mode: 'normal',
  language: 'vi',
  lengthUnit: 'mm',
  angleUnit: 'deg',
  cabinetDigitalOutputs: {},
  toolDigitalOutputs: {},
  gripperState: 'open',

  setRobots: (robots) =>
    set((state) => {
      const nextSelectedRobotId =
        state.selectedRobotId && robots.some((robot) => robot.id === state.selectedRobotId)
          ? state.selectedRobotId
          : persistedTrainingViewState.selectedRobotId &&
              robots.some((robot) => robot.id === persistedTrainingViewState.selectedRobotId)
            ? persistedTrainingViewState.selectedRobotId
            : (robots[0]?.id ?? null)

      const jointAnglesByRobotId = robots.reduce<Record<string, JointAngles>>((acc, robot) => {
        acc[robot.id] =
          state.jointAnglesByRobotId[robot.id] ??
          (robot.id === state.selectedRobotId
            ? state.jointAngles
            : robot.id === persistedTrainingViewState.selectedRobotId
              ? [...persistedTrainingViewState.jointAngles]
              : [...DEFAULT_JOINT_ANGLES])
        return acc
      }, {})

      const tcpPoseByRobotId = robots.reduce<Record<string, TCPPose>>((acc, robot) => {
        acc[robot.id] =
          state.tcpPoseByRobotId[robot.id] ??
          (robot.id === state.selectedRobotId ? state.tcpPose : { ...DEFAULT_TCP_POSE })
        return acc
      }, {})

      return {
        robots,
        selectedRobotId: nextSelectedRobotId,
        jointAnglesByRobotId,
        tcpPoseByRobotId,
        jointAngles: nextSelectedRobotId
          ? jointAnglesByRobotId[nextSelectedRobotId]
          : [...persistedTrainingViewState.jointAngles],
        tcpPose: nextSelectedRobotId
          ? (tcpPoseByRobotId[nextSelectedRobotId] ?? { ...DEFAULT_TCP_POSE })
          : { ...DEFAULT_TCP_POSE }
      }
    }),

  upsertRobot: (robot) =>
    set((state) => {
      const exists = state.robots.some((item) => item.id === robot.id)
      const robots = exists
        ? state.robots.map((item) => (item.id === robot.id ? robot : item))
        : [robot, ...state.robots]

      const nextSelectedRobotId = state.selectedRobotId ?? robot.id
      const jointAnglesByRobotId = {
        ...state.jointAnglesByRobotId,
        [robot.id]:
          state.jointAnglesByRobotId[robot.id] ??
          (robot.id === state.selectedRobotId ? state.jointAngles : [...DEFAULT_JOINT_ANGLES])
      }

      const tcpPoseByRobotId = {
        ...state.tcpPoseByRobotId,
        [robot.id]:
          state.tcpPoseByRobotId[robot.id] ??
          (robot.id === state.selectedRobotId ? state.tcpPose : { ...DEFAULT_TCP_POSE })
      }

      return {
        robots,
        selectedRobotId: nextSelectedRobotId,
        jointAnglesByRobotId,
        tcpPoseByRobotId,
        jointAngles: nextSelectedRobotId
          ? jointAnglesByRobotId[nextSelectedRobotId]
          : [...DEFAULT_JOINT_ANGLES],
        tcpPose: nextSelectedRobotId
          ? (tcpPoseByRobotId[nextSelectedRobotId] ?? state.tcpPose)
          : { ...DEFAULT_TCP_POSE }
      }
    }),

  removeRobot: (robotId) =>
    set((state) => {
      const robots = state.robots.filter((robot) => robot.id !== robotId)
      const jointAnglesByRobotId = Object.fromEntries(
        Object.entries(state.jointAnglesByRobotId).filter(([id]) => id !== robotId)
      ) as Record<string, JointAngles>
      const tcpPoseByRobotId = Object.fromEntries(
        Object.entries(state.tcpPoseByRobotId).filter(([id]) => id !== robotId)
      ) as Record<string, TCPPose>
      const robotRuntimeById = Object.fromEntries(
        Object.entries(state.robotRuntimeById).filter(([id]) => id !== robotId)
      ) as Record<string, BackendSimulatorStatus>
      const robotExecutionById = Object.fromEntries(
        Object.entries(state.robotExecutionById).filter(([id]) => id !== robotId)
      ) as Record<string, RobotExecutionState>
      const nextSelectedRobotId =
        state.selectedRobotId === robotId ? (robots[0]?.id ?? null) : state.selectedRobotId

      return {
        robots,
        selectedRobotId: nextSelectedRobotId,
        robotRuntimeById,
        robotExecutionById,
        jointAnglesByRobotId,
        tcpPoseByRobotId,
        jointAngles: nextSelectedRobotId
          ? (jointAnglesByRobotId[nextSelectedRobotId] ?? [...DEFAULT_JOINT_ANGLES])
          : [...persistedTrainingViewState.jointAngles],
        tcpPose: nextSelectedRobotId
          ? (tcpPoseByRobotId[nextSelectedRobotId] ?? { ...DEFAULT_TCP_POSE })
          : { ...DEFAULT_TCP_POSE }
      }
    }),

  updateRobotSceneBinding: (robotId, sceneBinding) =>
    set((state) => ({
      robots: state.robots.map((robot) =>
        robot.id === robotId
          ? {
              ...robot,
              sceneBinding
            }
          : robot
      )
    })),

  selectRobot: (robotId) =>
    set((state) => {
      const nextRobotId =
        robotId && state.robots.some((robot) => robot.id === robotId) ? robotId : null
      const nextJointAngles = nextRobotId
        ? (state.jointAnglesByRobotId[nextRobotId] ?? [...DEFAULT_JOINT_ANGLES])
        : state.jointAngles

      if (nextRobotId) {
        persistTrainingViewState({
          selectedRobotId: nextRobotId,
          jointAngles: nextJointAngles
        })
      }

      return {
        selectedRobotId: nextRobotId,
        jointAngles: nextJointAngles,
        tcpPose: nextRobotId
          ? (state.tcpPoseByRobotId[nextRobotId] ?? { ...DEFAULT_TCP_POSE })
          : { ...DEFAULT_TCP_POSE }
      }
    }),

  setWorkspaceMode: (workspaceMode) => {
    persistTrainingViewState({ workspaceMode })
    set((state) => ({
      workspaceMode,
      isIKMode: workspaceMode === 'factory' ? false : state.isIKMode,
      isRobotPlacementMode: workspaceMode === 'train' ? false : state.isRobotPlacementMode,
      robotPlacementTransformMode:
        workspaceMode === 'train' ? 'translate' : state.robotPlacementTransformMode,
      selectedJointName: null
    }))
  },
  setRobotExecution: (robotId, execution) =>
    set((state) => {
      const normalizedRobotId = robotId.trim()

      if (!normalizedRobotId) {
        return state
      }

      const currentExecution = state.robotExecutionById[normalizedRobotId] ?? {
        isPlaying: false,
        currentStepIndex: 0
      }

      return {
        robotExecutionById: {
          ...state.robotExecutionById,
          [normalizedRobotId]: {
            ...currentExecution,
            ...execution
          }
        }
      }
    }),

  clearRobotExecution: (robotId) =>
    set((state) => {
      const normalizedRobotId = robotId.trim()

      if (!normalizedRobotId) {
        return state
      }

      return {
        robotExecutionById: Object.fromEntries(
          Object.entries(state.robotExecutionById).filter(([id]) => id !== normalizedRobotId)
        ) as Record<string, RobotExecutionState>
      }
    }),

  clearAllRobotExecutions: () =>
    set({
      robotExecutionById: {}
    }),

  setRobotRuntime: (robotId, status) =>
    set((state) => {
      const normalizedRobotId = robotId.trim()

      if (!normalizedRobotId) {
        return state
      }

      return {
        robotRuntimeById: {
          ...state.robotRuntimeById,
          [normalizedRobotId]: {
            ...(state.robotRuntimeById[normalizedRobotId] ?? {
              isRunning: false,
              isConnected: false
            }),
            ...status
          }
        }
      }
    }),

  clearRobotRuntime: (robotId) =>
    set((state) => {
      const normalizedRobotId = robotId.trim()

      if (!normalizedRobotId) {
        return state
      }

      const robotRuntimeById = Object.fromEntries(
        Object.entries(state.robotRuntimeById).filter(([id]) => id !== normalizedRobotId)
      ) as Record<string, BackendSimulatorStatus>

      return {
        robotRuntimeById
      }
    }),

  clearAllRobotRuntime: () =>
    set({
      robotRuntimeById: {}
    }),

  setJointAngles: (angles) => {
    persistTrainingViewState({ jointAngles: angles })
    set((state) => ({
      jointAngles: angles,
      jointAnglesByRobotId: state.selectedRobotId
        ? {
            ...state.jointAnglesByRobotId,
            [state.selectedRobotId]: angles
          }
        : state.jointAnglesByRobotId
    }))
  },
  setJointAnglesForRobot: (robotId, angles) =>
    set((state) => {
      if (state.selectedRobotId === robotId) {
        persistTrainingViewState({ jointAngles: angles })
      }

      return {
        jointAngles: state.selectedRobotId === robotId ? angles : state.jointAngles,
        jointAnglesByRobotId: {
          ...state.jointAnglesByRobotId,
          [robotId]: angles
        }
      }
    }),

  setJointAnglesForRobots: (patch) =>
    set((state) => {
      const normalizedPatch = Object.fromEntries(
        Object.entries(patch).filter(([robotId, angles]) => robotId.trim() && angles.length === 6)
      ) as Record<string, JointAngles>

      if (Object.keys(normalizedPatch).length === 0) {
        return state
      }

      const selectedAngles = state.selectedRobotId
        ? normalizedPatch[state.selectedRobotId]
        : undefined

      if (selectedAngles) persistTrainingViewState({ jointAngles: selectedAngles })

      return {
        jointAngles: selectedAngles ?? state.jointAngles,
        jointAnglesByRobotId: {
          ...state.jointAnglesByRobotId,
          ...normalizedPatch
        }
      }
    }),
  setTCPPose: (pose) =>
    set((state) => ({
      tcpPose: pose,
      tcpPoseByRobotId: state.selectedRobotId
        ? {
            ...state.tcpPoseByRobotId,
            [state.selectedRobotId]: pose
          }
        : state.tcpPoseByRobotId
    })),

  setTCPPoseForRobot: (robotId, pose) =>
    set((state) => ({
      tcpPose: state.selectedRobotId === robotId ? pose : state.tcpPose,
      tcpPoseByRobotId: {
        ...state.tcpPoseByRobotId,
        [robotId]: pose
      }
    })),
  setIKMode: (enabled) => set({ isIKMode: enabled }),
  setCartesianInteractionMode: (cartesianInteractionMode) => set({ cartesianInteractionMode }),
  setRobotPlacementMode: (enabled) =>
    set((state) => ({
      isRobotPlacementMode: enabled,
      robotPlacementTransformMode: enabled ? state.robotPlacementTransformMode : 'translate',
      isIKMode: enabled ? false : state.isIKMode
    })),

  setRobotPlacementTransformMode: (mode) =>
    set({
      robotPlacementTransformMode: mode
    }),
  setProjectName: (name) => set({ projectName: name }),
  setCurrentFilePath: (path) => set({ currentFilePath: path }),
  setMode: (mode) => set({ mode }),
  setLanguage: (lang) => set({ language: lang }),
  setLengthUnit: (unit) => set({ lengthUnit: unit }),
  setAngleUnit: (unit) => set({ angleUnit: unit }),
  setDigitalOutput: (doType, doIndex, doValue) =>
    set((state) =>
      doType === 'cabinet'
        ? {
            cabinetDigitalOutputs: {
              ...state.cabinetDigitalOutputs,
              [doIndex]: doValue
            }
          }
        : {
            toolDigitalOutputs: {
              ...state.toolDigitalOutputs,
              [doIndex]: doValue
            }
          }
    ),
  setProgramSource: (programSource) => set({ programSource }),
  setGripperState: (gripperState) => set({ gripperState }),
  addStep: (step) =>
    set((state) => {
      const newStep: WorkflowStep = {
        ...step,
        id: createStepId()
      }
      return {
        steps: [...state.steps, newStep],
        selectedStepId: newStep.id
      }
    }),
  addSteps: (steps) =>
    set((state) => {
      if (steps.length === 0) return state

      const newSteps = steps.map<WorkflowStep>((step) => ({
        ...step,
        id: createStepId()
      }))
      return {
        steps: [...state.steps, ...newSteps],
        selectedStepId: newSteps.at(-1)?.id ?? state.selectedStepId
      }
    }),

  removeStep: (id) =>
    set((state) => {
      const filtered = state.steps.filter((s) => s.id !== id)
      return {
        steps: filtered,
        selectedStepId: state.selectedStepId === id ? null : state.selectedStepId
      }
    }),

  clearSteps: () =>
    set({
      steps: [],
      selectedStepId: null,
      currentStepIndex: 0,
      isPlaying: false
    }),

  updateStep: (id, updated) =>
    set((state) => ({
      steps: state.steps.map((s) => (s.id === id ? { ...s, ...updated } : s))
    })),

  reorderSteps: (newSteps) => set({ steps: newSteps }),

  setSelectedStepId: (id) => set({ selectedStepId: id }),

  setPlaying: (playing) => set({ isPlaying: playing }),
  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),
  setCurrentStepIndex: (index) => set({ currentStepIndex: index }),

  resetSimulation: () => set({ currentStepIndex: 0, isPlaying: false }),
  setSelectedJointName: (name) => set({ selectedJointName: name })
}))
