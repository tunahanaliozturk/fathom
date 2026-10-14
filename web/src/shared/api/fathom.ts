// The two calls the page makes, both to its own origin. nginx forwards them to the API and adds the read key
// (web/nginx.conf, ADR 8), so nothing here knows a credential and no header carries one.
//
// The contract is docs/openapi.json. schema.d.ts is generated from it, and every answer is also parsed here, at the
// one place it enters the page: a type says what the server promised, a parse checks what it sent (ADR 10).

import { z } from 'zod'

import { MODES, type Mode } from './modes'
import type { components } from './schema'

// Zod normally compiles a fast parser with `new Function`, and tries it once to see whether it may. The page's
// content security policy forbids that, and even the attempt is reported as a violation. A few small objects do not
// need the fast path, and without it nothing in the bundle evaluates a string as code.
z.config({ jitless: true })

/** The one collection the proxy forwards. The name appears again in nginx.conf and tools/seed.py. */
export const COLLECTION = 'demo'
const BASE = `/api/v1/collections/${COLLECTION}`

/** How many hits a list shows. The comparison draws exactly this many rows per retriever. */
export const SHOWN = 10

const Hit = z.object({
  document_id: z.string(),
  ordinal: z.number().int(),
  title: z.string(),
  snippet: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  score: z.number(),
  ranks: z.record(z.string(), z.number().int().positive()).nullish(),
})

const SearchResponse = z.object({
  mode: z.enum(MODES),
  took_ms: z.number(),
  hits: z.array(Hit),
})

const Stats = z.object({
  documents: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
})

/** RFC 9457. The API and the proxy both answer errors in this shape. */
const Problem = z.object({ title: z.string(), detail: z.string().optional() })

/**
 * Compiles only while everything the OpenAPI document says the server sends is something the parser accepts.
 * Renaming or retyping a response field on the server changes schema.d.ts, and this stops type-checking.
 */
type Accepts<Schema extends z.ZodType, Sent extends z.input<Schema>> = Sent
export type SentBySearch = Accepts<typeof SearchResponse, components['schemas']['SearchResponse']>
export type SentByStats = Accepts<typeof Stats, components['schemas']['Stats']>

export type Hit = z.output<typeof Hit>
export type SearchResponse = z.output<typeof SearchResponse>
export type Stats = z.output<typeof Stats>

export type FailureKind = 'network' | 'rate-limited' | 'server' | 'refused' | 'contract'

/** A request that did not produce an answer the page can use. `status` is null when no answer arrived at all. */
export class ApiFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly status: number | null,
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail === '' ? title : `${title}: ${detail}`)
    this.name = 'ApiFailure'
  }
}

const RATE_LIMITED = 429

async function refusal(response: Response): Promise<ApiFailure> {
  const problem = Problem.safeParse(await response.json().catch(() => null))
  const kind = response.status === RATE_LIMITED ? 'rate-limited' : response.status >= 500 ? 'server' : 'refused'
  return problem.success
    ? new ApiFailure(kind, response.status, problem.data.title, problem.data.detail ?? '')
    : new ApiFailure(kind, response.status, response.statusText, '')
}

async function request<Schema extends z.ZodType>(
  schema: Schema,
  path: string,
  init: RequestInit,
): Promise<z.output<Schema>> {
  let response: Response
  try {
    response = await fetch(`${BASE}/${path}`, init)
  } catch (cause) {
    // A cancelled request is not a failure: the caller asked for it to stop.
    if (init.signal?.aborted === true) throw cause
    throw new ApiFailure('network', null, 'No answer', cause instanceof Error ? cause.message : '')
  }
  if (!response.ok) throw await refusal(response)
  const parsed = schema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) {
    throw new ApiFailure('contract', response.status, 'Unexpected answer', z.prettifyError(parsed.error))
  }
  return parsed.data
}

/** The top hits for `query`, each with its rank in every retriever that ran. */
export function search(query: string, mode: Mode, signal: AbortSignal): Promise<SearchResponse> {
  const body: components['schemas']['SearchRequest'] = { query, mode, k: SHOWN, explain: true }
  return request(SearchResponse, 'search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

export function stats(signal: AbortSignal): Promise<Stats> {
  return request(Stats, 'stats', { signal })
}
