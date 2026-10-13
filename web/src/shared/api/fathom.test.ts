import { afterEach, describe, expect, it, vi } from 'vitest'

import { found, hit, json, network, problem } from '@/test/network'

import { ApiFailure, search, stats } from './fathom'

afterEach(() => vi.unstubAllGlobals())

const never = new AbortController().signal

/** The failure a call ends in. A call that succeeds, or fails some other way, fails the test. */
async function failureOf(call: Promise<unknown>): Promise<ApiFailure> {
  const outcome: unknown = await call.then(
    () => null,
    (error: unknown) => error,
  )
  if (!(outcome instanceof ApiFailure)) throw new Error(`expected an ApiFailure, got ${String(outcome)}`)
  return outcome
}

describe('search', () => {
  it('posts the query to the proxied route of the demo collection, with no credential', async () => {
    const calls = network(() => found('lexical', [hit('a', { ranks: { lexical: 1 } })]))

    const response = await search('who built it', 'lexical', never)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/v1/collections/demo/search')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({ query: 'who built it', mode: 'lexical', k: 10, explain: true })
    expect(calls[0]?.headers.has('Authorization')).toBe(false)
    expect(response.hits[0]?.ranks).toEqual({ lexical: 1 })
  })

  it('accepts a hit without ranks, which is what the API sends when explain is off', async () => {
    const { ranks: _ranks, ...withoutRanks } = hit('b')
    network(() => found('hybrid', [hit('a', { ranks: null }), withoutRanks]))

    const response = await search('q', 'hybrid', never)

    expect(response.hits.map((one) => one.ranks ?? null)).toEqual([null, null])
  })

  it('refuses an answer in another shape instead of passing it on', async () => {
    network(() => json({ mode: 'hybrid', took: 3, results: [] }))

    const failure = await failureOf(search('q', 'hybrid', never))

    expect(failure.kind).toBe('contract')
    expect(failure.detail).toContain('took_ms')
  })

  it('refuses an answer that is not JSON at all', async () => {
    network(() => new Response('<html>ok</html>', { status: 200 }))

    expect((await failureOf(search('q', 'hybrid', never))).kind).toBe('contract')
  })

  it('reports a rate limit with the title and detail the proxy sent', async () => {
    network(() => problem(429, 'Too many requests', 'this address is sending requests faster than the proxy allows'))

    const failure = await failureOf(search('q', 'hybrid', never))

    expect(failure).toMatchObject({
      kind: 'rate-limited',
      status: 429,
      title: 'Too many requests',
      detail: 'this address is sending requests faster than the proxy allows',
    })
  })

  it('reports a server error with the problem document title and detail', async () => {
    network(() => problem(503, 'Not ready', 'the database is unreachable'))

    const failure = await failureOf(search('q', 'hybrid', never))

    expect(failure).toMatchObject({
      kind: 'server',
      status: 503,
      title: 'Not ready',
      detail: 'the database is unreachable',
    })
  })

  it('falls back to the status text when an error has no problem document', async () => {
    network(() => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }))

    const failure = await failureOf(search('q', 'hybrid', never))

    expect(failure).toMatchObject({ kind: 'server', status: 502, title: 'Bad Gateway', detail: '' })
    expect(failure.message).toBe('Bad Gateway')
  })

  it('reports any other refusal as one', async () => {
    network(() => problem(404, 'Not found', 'this origin serves search and stats for one collection'))

    expect(await failureOf(search('q', 'hybrid', never))).toMatchObject({ kind: 'refused', status: 404 })
  })

  it('reports a request that got no answer', async () => {
    network(() => {
      throw new TypeError('Failed to fetch')
    })

    const failure = await failureOf(search('q', 'hybrid', never))

    expect(failure).toMatchObject({ kind: 'network', status: null, detail: 'Failed to fetch' })
  })

  it('lets a cancelled request end as a cancellation, not as a failure to show', async () => {
    network(() => new Promise<Response>(() => undefined))
    const controller = new AbortController()

    const pending = search('q', 'hybrid', controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('stats', () => {
  it('reads the counts for the demo collection', async () => {
    const calls = network(() => json({ documents: 121, chunks: 128, pending: 3 }))

    expect(await stats(never)).toEqual({ documents: 121, chunks: 128, pending: 3 })
    expect(calls[0]?.url).toBe('/api/v1/collections/demo/stats')
    expect(calls[0]?.method).toBe('GET')
  })

  it('refuses a count that cannot be one', async () => {
    network(() => json({ documents: 1, chunks: 1, pending: -1 }))

    expect((await failureOf(stats(never))).kind).toBe('contract')
  })
})
