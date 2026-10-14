// Kept apart from fathom.ts so the router can read a mode out of the address without pulling the parser and the
// query cache into the first chunk.

export const MODES = ['hybrid', 'lexical', 'vector'] as const
export type Mode = (typeof MODES)[number]

export const RETRIEVERS = ['lexical', 'vector'] as const
export type Retriever = (typeof RETRIEVERS)[number]

/** The longest query the API accepts (SearchRequest.query in docs/openapi.json). */
export const QUERY_MAX = 1000
