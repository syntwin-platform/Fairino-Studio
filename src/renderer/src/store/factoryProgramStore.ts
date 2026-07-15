import { create } from 'zustand'
import {
  DEFAULT_FACTORY_COORDINATION_MODE,
  DEFAULT_FACTORY_FAILURE_POLICY
} from '../types/factoryProgram.types'
import type {
  FactoryProgramScope,
  FactoryRobotProgramState,
  FactoryRunMetadata,
  ValidatedLuaProgram
} from '../types/factoryProgram.types'

const defaultRun: FactoryRunMetadata = {
  factoryRunId: null,
  coordinationMode: DEFAULT_FACTORY_COORDINATION_MODE,
  failurePolicy: DEFAULT_FACTORY_FAILURE_POLICY,
  scheduledStartAtUtc: null,
  actualStartSkewMs: null,
  maxStartShiftMs: null,
  status: 'idle',
  error: null
}

function createRobotState(robotId: string): FactoryRobotProgramState {
  return {
    robotId,
    selected: true,
    status: 'idle',
    readinessErrors: []
  }
}

interface FactoryProgramStore {
  isModalOpen: boolean
  scope: FactoryProgramScope
  activeRobotId: string | null
  targetRobotIds: string[]
  program: ValidatedLuaProgram | null
  programsByKey: Record<string, ValidatedLuaProgram>
  targetProgramKeyByRobotId: Record<string, string>
  robotStates: Record<string, FactoryRobotProgramState>
  run: FactoryRunMetadata
  isBusy: boolean

  openSingle: (robotId: string) => void
  openBatch: (robotIds: string[]) => void
  closeModal: () => void
  setProgram: (program: ValidatedLuaProgram | null) => void
  assignProgramToTargets: (program: ValidatedLuaProgram, robotIds: string[]) => void
  setTargetSelected: (robotId: string, selected: boolean) => void
  setTargets: (robotIds: string[]) => void
  patchRobotState: (robotId: string, openSingle: Partial<FactoryRobotProgramState>) => void
  setRunMetadata: (patch: Partial<FactoryRunMetadata>) => void
  setBusy: (busy: boolean) => void
  reset: () => void
}

function createProgramKey(
  program: ValidatedLuaProgram,
  programsByKey: Record<string, ValidatedLuaProgram>
): string {
  const existingEntry = Object.entries(programsByKey).find(
    ([, existingProgram]) => existingProgram.luaContent === program.luaContent
  )

  if (existingEntry) return existingEntry[0]

  let checksum = 2166136261

  for (let index = 0; index < program.luaContent.length; index++) {
    checksum ^= program.luaContent.charCodeAt(index)
    checksum = Math.imul(checksum, 16777619)
  }

  const name = (program.projectName || program.fileName.replace(/\.lua$/i, ''))
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const baseKey = `${name || 'lua-program'}-${(checksum >>> 0).toString(16)}`
  let candidate = baseKey
  let suffix = 2

  while (programsByKey[candidate]) {
    candidate = `${baseKey}-${suffix}`
    suffix++
  }

  return candidate
}

function createProgramAssignmentPatch(
  state: FactoryProgramStore,
  program: ValidatedLuaProgram,
  programKey: string,
  robotIds: string[]
): Partial<FactoryProgramStore> {
  const selectedRobotIds = new Set(state.targetRobotIds)
  const assignmentTargets = robotIds.filter((robotId) => selectedRobotIds.has(robotId))
  const targetProgramKeyByRobotId = { ...state.targetProgramKeyByRobotId }

  for (const robotId of assignmentTargets) {
    targetProgramKeyByRobotId[robotId] = programKey
  }

  return {
    program,
    programsByKey: {
      ...state.programsByKey,
      [programKey]: program
    },
    targetProgramKeyByRobotId,
    run: {
      ...defaultRun,
      coordinationMode: state.run.coordinationMode,
      failurePolicy: state.run.failurePolicy
    },
    robotStates: Object.fromEntries(
      Object.entries(state.robotStates).map(([robotId, robotState]) => [
        robotId,
        {
          ...robotState,
          status: 'idle',
          readinessErrors: [],
          programId: undefined,
          prepareCommandId: undefined,
          commandId: undefined,
          message: undefined
        }
      ])
    )
  }
}

export const useFactoryProgramStore = create<FactoryProgramStore>((set) => ({
  isModalOpen: false,
  scope: 'single',
  activeRobotId: null,
  targetRobotIds: [],
  program: null,
  programsByKey: {},
  targetProgramKeyByRobotId: {},
  robotStates: {},
  run: { ...defaultRun },
  isBusy: false,

  openSingle: (robotId) =>
    set((state) => {
      if (state.isBusy) {
        return {
          ...state,
          isModalOpen: true
        }
      }

      return {
        isModalOpen: true,
        scope: 'single',
        activeRobotId: robotId,
        targetRobotIds: [robotId],
        robotStates: { [robotId]: createRobotState(robotId) },
        program: null,
        programsByKey: {},
        targetProgramKeyByRobotId: {},
        run: { ...defaultRun },
        isBusy: false
      }
    }),

  openBatch: (robotIds) =>
    set((state) => {
      if (state.isBusy) {
        return {
          ...state,
          isModalOpen: true
        }
      }

      const uniqueIds = [...new Set(robotIds)]

      return {
        isModalOpen: true,
        scope: 'batch',
        activeRobotId: null,
        targetRobotIds: uniqueIds,
        robotStates: Object.fromEntries(
          uniqueIds.map((robotId) => [robotId, createRobotState(robotId)])
        ),
        program: null,
        programsByKey: {},
        targetProgramKeyByRobotId: {},
        run: { ...defaultRun },
        isBusy: false
      }
    }),

  closeModal: () => set({ isModalOpen: false }),

  setProgram: (program) =>
    set((state) => {
      if (!program) {
        return {
          program: null,
          programsByKey: {},
          targetProgramKeyByRobotId: {},
          run: {
            ...defaultRun,
            coordinationMode: state.run.coordinationMode,
            failurePolicy: state.run.failurePolicy
          }
        }
      }

      const programKey = createProgramKey(program, state.programsByKey)

      return createProgramAssignmentPatch(state, program, programKey, state.targetRobotIds)
    }),

  assignProgramToTargets: (program, robotIds) =>
    set((state) => {
      const programKey = createProgramKey(program, state.programsByKey)

      return createProgramAssignmentPatch(state, program, programKey, robotIds)
    }),

  setTargetSelected: (robotId, selected) =>
    set((state) => {
      const current = state.robotStates[robotId] ?? createRobotState(robotId)

      return {
        targetRobotIds: selected
          ? [...new Set([...state.targetRobotIds, robotId])]
          : state.targetRobotIds.filter((id) => id !== robotId),
        robotStates: {
          ...state.robotStates,
          [robotId]: { ...current, selected }
        }
      }
    }),

  setTargets: (robotIds) =>
    set((state) => ({
      targetRobotIds: [...new Set(robotIds)],
      robotStates: Object.fromEntries(
        Object.keys(state.robotStates).map((robotId) => [
          robotId,
          {
            ...state.robotStates[robotId],
            selected: robotIds.includes(robotId)
          }
        ])
      )
    })),

  patchRobotState: (robotId, patch) =>
    set((state) => ({
      robotStates: {
        ...state.robotStates,
        [robotId]: {
          ...(state.robotStates[robotId] ?? createRobotState(robotId)),
          ...patch
        }
      }
    })),

  setRunMetadata: (patch) =>
    set((state) => ({
      run: { ...state.run, ...patch }
    })),

  setBusy: (isBusy) => set({ isBusy }),

  reset: () =>
    set({
      isModalOpen: false,
      scope: 'single',
      activeRobotId: null,
      targetRobotIds: [],
      program: null,
      programsByKey: {},
      targetProgramKeyByRobotId: {},
      robotStates: {},
      run: { ...defaultRun },
      isBusy: false
    })
}))
