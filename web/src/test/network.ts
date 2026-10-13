// A stand-in for the network, one layer below the code under test: `fetch` itself is replaced, so the client, its
// parsing, the query cache and the components all run as they do in the page.

import { vi } from 'vitest'

export interface Call {
  url: string
  method: string
  headers: Headers
  body: unknown
  signal: AbortSignal | null
}

type Answer = (call: Call) => Response | Promise<Response>

/** Replaces `fetch` until `vi.unstubAllGlobals()`. Returns the calls made so far, in order. */
export function network(answer: Answer): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const sent: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: sent,
      signal: init.signal ?? null,
    }
    calls.push(call)
    return new Promise<Response>((resolve, reject) => {
      // What a browser does with a request whose signal fires: the promise rejects with an AbortError.
      call.signal?.addEventListener('abort', () => reject(new DOMException('The request was aborted', 'AbortError')))
      Promise.resolve()
        .then(() => answer(call))
        .then(resolve, reject)
    })
  })
  return calls
}

export function json(body: unknown, status = 200, type = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } })
}

/** An error the way the API and the proxy send one (RFC 9457). */
export function problem(status: number, title: string, detail: string): Response {
  return json({ type: 'about:blank', title, status, detail }, status, 'application/problem+json')
}

export interface WireHit {
  document_id: string
  ordinal: number
  title: string
  snippet: string
  metadata: Record<string, unknown>
  score: number
  ranks?: Record<string, number> | null
}

/** A hit as the API sends it. Only what a test cares about needs saying. */
export function hit(id: string, given: Partial<WireHit> = {}): WireHit {
  return {
    document_id: id,
    ordinal: 0,
    title: `Title of ${id}`,
    snippet: `Snippet of ${id}`,
    metadata: {},
    score: 0.1,
    ranks: {},
    ...given,
  }
}

export function found(mode: string, hits: WireHit[], took = 12.34): Response {
  return json({ mode, took_ms: took, hits })
}

/** A promise and the function that settles it, for an answer a test wants to hold back. */
export function held<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** The mode a search request asked for. */
export function modeOf(call: Call): string {
  const body = call.body
  return typeof body === 'object' && body !== null && 'mode' in body && typeof body.mode === 'string' ? body.mode : ''
}
