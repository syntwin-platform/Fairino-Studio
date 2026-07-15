import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFactoryRun } from './backendFactoryRunClient'

const fetchMock = vi.fn()

describe('backendFactoryRunClient', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: vi.fn().mockResolvedValue({
        id: 'factory-run-1'
      })
    } as unknown as Response)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['Synchronized', 'IsolateTarget'],
    ['ParallelIndependent', 'AbortExecutionGroup']
  ] as const)(
    'serializes coordination mode %s and failure policy %s',
    async (coordinationMode, failurePolicy) => {
      await createFactoryRun(
        {
          backendUrl: 'http://localhost:5000/',
          token: 'test-token'
        },
        {
          companyId: 'company-1',
          coordinationMode,
          failurePolicy,
          programName: 'coffee_machine_workflow',
          luaFileName: 'coffee_machine_workflow.lua',
          luaContent: "print('factory')",
          robotIds: ['robot-1', 'robot-2']
        }
      )

      expect(fetchMock).toHaveBeenCalledOnce()

      const call = fetchMock.mock.calls[0]
      expect(call).toBeDefined()

      const [url, init] = call as [string, RequestInit]

      expect(url).toBe('http://localhost:5000/api/factory-runs')
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token'
      })

      expect(JSON.parse(String(init.body))).toEqual({
        companyId: 'company-1',
        coordinationMode,
        failurePolicy,
        programName: 'coffee_machine_workflow',
        luaFileName: 'coffee_machine_workflow.lua',
        luaContent: "print('factory')",
        robotIds: ['robot-1', 'robot-2']
      })
    }
  )

  it('serializes deduplicated source programs and target assignments', async () => {
    await createFactoryRun(
      {
        backendUrl: 'http://localhost:5000',
        token: 'test-token'
      },
      {
        companyId: 'company-1',
        coordinationMode: 'ParallelIndependent',
        failurePolicy: 'IsolateTarget',
        programs: [
          {
            key: 'pick-source',
            programName: 'pick',
            luaFileName: 'pick.lua',
            luaContent: "print('pick')"
          },
          {
            key: 'place-source',
            programName: 'place',
            luaFileName: 'place.lua',
            luaContent: "print('place')"
          }
        ],
        targets: [
          { robotId: 'robot-1', programKey: 'pick-source' },
          { robotId: 'robot-2', programKey: 'pick-source' },
          { robotId: 'robot-3', programKey: 'place-source' }
        ]
      }
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))

    expect(body.programs).toHaveLength(2)
    expect(body.targets).toEqual([
      { robotId: 'robot-1', programKey: 'pick-source' },
      { robotId: 'robot-2', programKey: 'pick-source' },
      { robotId: 'robot-3', programKey: 'place-source' }
    ])
    expect(body).not.toHaveProperty('luaContent')
    expect(body).not.toHaveProperty('robotIds')
  })
})
