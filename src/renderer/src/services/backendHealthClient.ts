export class BackendHealthError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'BackendHealthError'
  }
}

function backendHealthUrl(backendUrl: string): string {
  return `${backendUrl.trim().replace(/\/+$/, '')}/health/live`
}

export async function checkBackendHealth(
  backendUrl: string,
  signal?: AbortSignal,
  timeoutMs = 3000
): Promise<void> {
  const controller = new AbortController()
  let timedOut = false
  const handleExternalAbort = (): void => controller.abort(signal?.reason)
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  signal?.addEventListener('abort', handleExternalAbort, { once: true })

  try {
    const response = await fetch(backendHealthUrl(backendUrl), {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store'
    })

    if (!response.ok) {
      throw new BackendHealthError(
        response.status,
        `Backend health check failed (HTTP ${response.status}).`
      )
    }
  } catch (error) {
    if (signal?.aborted) throw error

    if (timedOut) {
      throw new BackendHealthError(0, `Backend không phản hồi sau ${timeoutMs} ms.`)
    }

    if (error instanceof BackendHealthError) throw error

    throw new BackendHealthError(
      0,
      `Không kết nối được Backend tại ${backendUrl.trim()}. Hãy kiểm tra API đang chạy.`
    )
  } finally {
    globalThis.clearTimeout(timeoutId)
    signal?.removeEventListener('abort', handleExternalAbort)
  }
}
