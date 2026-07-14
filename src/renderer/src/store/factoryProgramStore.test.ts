import { beforeEach, describe, expect, it } from 'vitest'

import { useFactoryProgramStore } from './factoryProgramStore'

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
})
