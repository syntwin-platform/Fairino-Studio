import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteRobot, listCompanies, listRobots } from './backendRobotClient'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('backendRobotClient', () => {
  it('loads companies available to the signed-in user', async () => {
    const companies = [
      {
        id: 'company-1',
        name: 'SynTwin Factory',
        slug: 'syntwin-factory',
        status: 'Active',
        currentUserRole: 'Owner',
        subscriptionPlan: 'Premium',
        maxRobots: 30,
        canView3D: true,
        canSendCommand: true
      }
    ]
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(companies), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(listCompanies('https://backend.example/', 'token-1')).resolves.toEqual(companies)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.example/api/companies',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' })
      })
    )
  })

  it('loads the robots for the requested company with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(listRobots('http://localhost:5200/', 'token-1', 'company-1')).resolves.toEqual([])

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5200/api/robots?companyId=company-1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' })
      })
    )
  })

  it('deletes the requested robot with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      deleteRobot('https://backend.example/', 'token-1', 'robot-1')
    ).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.example/api/robots/robot-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' })
      })
    )
  })

  it('preserves HTTP status so an expired session can be handled separately', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )

    const request = listRobots('http://localhost:5200', 'expired-token', 'company-1')

    await expect(request).rejects.toMatchObject({
      name: 'BackendRobotClientError',
      status: 401,
      message: 'Unauthorized'
    })
  })

  it('converts a network failure into a retryable status-zero error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const request = listRobots('http://localhost:5200', 'token-1', 'company-1')

    await expect(request).rejects.toMatchObject({
      name: 'BackendRobotClientError',
      status: 0,
      message: expect.stringMatching(/không kết nối được Backend/i)
    })
  })
})
