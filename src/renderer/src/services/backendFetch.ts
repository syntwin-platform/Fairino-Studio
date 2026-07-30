import type { BackendRequestOptions, BackendResponsePayload } from '../../../preload/api.types'

function abortError(reason?: unknown): DOMException {
  return new DOMException(
    typeof reason === 'string' && reason ? reason : 'The operation was aborted.',
    'AbortError'
  )
}

async function waitForBackendResponse(
  request: Promise<BackendResponsePayload>,
  signal?: AbortSignal | null
): Promise<BackendResponsePayload> {
  if (!signal) {
    return await request
  }

  if (signal.aborted) {
    throw abortError(signal.reason)
  }

  return await new Promise((resolve, reject) => {
    const handleAbort = (): void => reject(abortError(signal.reason))

    signal.addEventListener('abort', handleAbort, { once: true })

    request.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', handleAbort)
    })
  })
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return input.url
  }

  return input.toString()
}

function requestOptions(input: RequestInfo | URL, init: RequestInit): BackendRequestOptions {
  const sourceRequest = input instanceof Request ? input : undefined
  const headers = new Headers(sourceRequest?.headers)

  new Headers(init.headers).forEach((value, key) => {
    headers.set(key, value)
  })

  const serializedHeaders: Record<string, string> = {}
  headers.forEach((value, key) => {
    serializedHeaders[key] = value
  })

  if (init.body != null && typeof init.body !== 'string') {
    throw new Error('Only text and JSON backend request bodies are supported.')
  }

  return {
    method: init.method || sourceRequest?.method || 'GET',
    headers: serializedHeaders,
    body: typeof init.body === 'string' ? init.body : undefined
  }
}

export async function backendFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  if (
    typeof window === 'undefined' ||
    !window.api ||
    typeof window.api.backendRequest !== 'function'
  ) {
    return await fetch(input, init)
  }

  const payload = await waitForBackendResponse(
    window.api.backendRequest(requestUrl(input), requestOptions(input, init)),
    init.signal
  )

  return new Response(payload.body, {
    status: payload.status,
    statusText: payload.statusText,
    headers: payload.headers
  })
}
