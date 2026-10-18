import { makePayload } from './payload'
import { send } from './transport'

function makeFetch(response: () => Response | Promise<Response>) {
  return jasmine.createSpy<typeof fetch>('fetch').and.callFake(async () => response())
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('Collector transport', () => {
  const payload = makePayload({ components: {}, extended: {}, nonce: 'abc' }, Date.now())

  it('posts the payload as JSON and returns only the request id', async () => {
    const fetchMock = makeFetch(() => jsonResponse({ requestId: 'req-1', visitorId: 'must-not-leak' }))
    const result = await send(payload, { endpoint: '/collect', fetch: fetchMock, headers: { 'X-Test': '1' } })

    expect(result).toEqual({ requestId: 'req-1' })
    const [url, init] = fetchMock.calls.mostRecent().args
    expect(url).toBe('/collect')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Test': '1' })
    expect(JSON.parse(init?.body as string)).toEqual(JSON.parse(JSON.stringify(payload)))
  })

  it('allows to change the credentials mode', async () => {
    const fetchMock = makeFetch(() => jsonResponse({ requestId: 'r' }))
    await send(payload, { endpoint: '/c', fetch: fetchMock, credentials: 'include' })
    expect(fetchMock.calls.mostRecent().args[1]?.credentials).toBe('include')
  })

  it('throws on an error status', async () => {
    const fetchMock = makeFetch(() => jsonResponse({ requestId: 'r' }, 500))
    await expectAsync(send(payload, { endpoint: '/c', fetch: fetchMock })).toBeRejectedWithError(/HTTP 500/)
  })

  it('throws when the response has no request id', async () => {
    for (const body of [{}, null, { requestId: 5 }, { requestId: '' }]) {
      const fetchMock = makeFetch(() => jsonResponse(body))
      await expectAsync(send(payload, { endpoint: '/c', fetch: fetchMock })).toBeRejectedWithError(/no request id/)
    }
  })

  it('throws when the network fails', async () => {
    const fetchMock = makeFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    await expectAsync(send(payload, { endpoint: '/c', fetch: fetchMock })).toBeRejectedWithError('Failed to fetch')
  })

  it('aborts the request after the timeout', async () => {
    const fetchMock = jasmine.createSpy<typeof fetch>('fetch').and.callFake(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const startedAt = Date.now()
    await expectAsync(send(payload, { endpoint: '/c', fetch: fetchMock, timeoutMs: 50 })).toBeRejected()
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })
})
