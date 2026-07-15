import { beforeEach, describe, expect, it } from 'vitest'

import { useFactoryProgramStore } from './factoryProgramStore'
import type { ValidatedLuaProgram } from '../types/factoryProgram.types'

function createProgram(fileName: string, luaContent: string): ValidatedLuaProgram {
  return {
    fileName,
    luaContent,
    projectName: fileName.replace(/\.lua$/i, ''),
    steps: [],
    diagnostics: [],
    raw: {} as ValidatedLuaProgram['raw']
  }
}

describe('factoryProgramStore execution policy', () => {
  beforeEach(() => {
    useFactoryProgramStore.getState().reset()
  })

  it('uses synchronized isolate-target defaults', () => {
    const { run } = useFactoryProgramStore.getState()

    expect(run.coordinationMode).toBe('Synchronized')
    expect(run.failurePolicy).toBe('IsolateTarget')
  })

  it('preserves policy when run metadata receives a partial update', () => {
    useFactoryProgramStore.getState().setRunMetadata({
      status: 'running'
    })

    const { run } = useFactoryProgramStore.getState()

    expect(run.status).toBe('running')
    expect(run.coordinationMode).toBe('Synchronized')
    expect(run.failurePolicy).toBe('IsolateTarget')
  })

  it('restores safe defaults after reset', () => {
    useFactoryProgramStore.getState().setRunMetadata({
      coordinationMode: 'ParallelIndependent',
      failurePolicy: 'AbortExecutionGroup'
    })

    useFactoryProgramStore.getState().reset()

    const { run } = useFactoryProgramStore.getState()

    expect(run.coordinationMode).toBe('Synchronized')
    expect(run.failurePolicy).toBe('IsolateTarget')
  })

  it('preserves the user-selected execution policy when program changes', () => {
    useFactoryProgramStore.getState().setRunMetadata({
      coordinationMode: 'ParallelIndependent',
      failurePolicy: 'AbortExecutionGroup'
    })

    useFactoryProgramStore.getState().setProgram(null)

    const { run } = useFactoryProgramStore.getState()

    expect(run.coordinationMode).toBe('ParallelIndependent')
    expect(run.failurePolicy).toBe('AbortExecutionGroup')
  })

  it('deduplicates identical LUA content assigned to different targets', () => {
    const program = createProgram('shared.lua', "print('shared')")
    const store = useFactoryProgramStore.getState()

    store.openBatch(['robot-1', 'robot-2'])
    store.assignProgramToTargets(program, ['robot-1'])
    store.assignProgramToTargets(program, ['robot-2'])

    const { programsByKey, targetProgramKeyByRobotId } = useFactoryProgramStore.getState()

    expect(Object.keys(programsByKey)).toHaveLength(1)
    expect(targetProgramKeyByRobotId['robot-1']).toBe(targetProgramKeyByRobotId['robot-2'])
  })

  it('keeps distinct LUA sources for targets with different content', () => {
    const store = useFactoryProgramStore.getState()

    store.openBatch(['robot-1', 'robot-2'])
    store.assignProgramToTargets(createProgram('pick.lua', "print('pick')"), ['robot-1'])
    store.assignProgramToTargets(createProgram('place.lua', "print('place')"), ['robot-2'])

    const { programsByKey, targetProgramKeyByRobotId } = useFactoryProgramStore.getState()

    expect(Object.keys(programsByKey)).toHaveLength(2)
    expect(targetProgramKeyByRobotId['robot-1']).not.toBe(targetProgramKeyByRobotId['robot-2'])
  })

  it('keeps legacy setProgram behavior by assigning one LUA to every target', () => {
    const store = useFactoryProgramStore.getState()

    store.openBatch(['robot-1', 'robot-2'])
    store.setProgram(createProgram('legacy.lua', "print('legacy')"))

    const { targetProgramKeyByRobotId } = useFactoryProgramStore.getState()

    expect(targetProgramKeyByRobotId['robot-1']).toBeDefined()
    expect(targetProgramKeyByRobotId['robot-1']).toBe(targetProgramKeyByRobotId['robot-2'])
  })
})
