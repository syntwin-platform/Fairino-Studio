import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { previewLuaProgramForRobot } from './backendLuaImportClient'

const fetchMock = vi.fn()
const context = {
  backendUrl: 'http://localhost:5200/',
  robotId: 'robot-1',
  token: 'token-1'
}

function abortablePendingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true }
    )
  })
}

describe('backendLuaImportClient', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('passes the execution contract through and binds an abort signal', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        metadata: { projectName: 'coffee' },
        variables: {},
        points: {},
        parsedSteps: [],
        diagnostics: [],
        executionReady: true,
        compiledProgramHash: 'abc123',
        unsupportedSteps: []
      })
    } as unknown as Response)

    const result = await previewLuaProgramForRobot(context, 'coffee.lua', '-- program')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]

    expect(url).toBe('http://localhost:5200/api/robots/robot-1/programs/import/lua/preview')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(result.executionReady).toBe(true)
    expect(result.compiledProgramHash).toBe('abc123')
  })

  it('cancels an obsolete preview through the caller signal', async () => {
    fetchMock.mockImplementation(abortablePendingFetch)
    const controller = new AbortController()
    const request = previewLuaProgramForRobot(context, 'old.lua', '-- old', controller.signal)

    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails a stalled backend preview after the bounded request timeout', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(abortablePendingFetch)
    const request = previewLuaProgramForRobot(context, 'stalled.lua', '-- stalled')
    const rejection = expect(request).rejects.toThrow(
      'Backend LUA request timed out after 15 seconds.'
    )

    await vi.advanceTimersByTimeAsync(15_000)
    await rejection
  })
})
