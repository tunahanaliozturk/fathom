// The two ranking settings the page needs to explain a score. They are the service's defaults (FATHOM_CANDIDATES and
// FATHOM_RRF_K in docs/operations.md) and the values the compose stack runs with. The API does not report them, so a
// stack started with other values would show arithmetic that does not add up to the score beside it.

import type { Hit } from './api/fathom'
import type { Retriever } from './api/modes'

/** How many passages each retriever hands to fusion. A rank is a place among these. */
export const CANDIDATES = 50

/** Reciprocal rank fusion's damping constant (ADR 3). */
export const RRF_K = 10

/** What one retriever adds to a passage's fused score for placing it at `rank`. */
export function contribution(rank: number): number {
  return 1 / (RRF_K + rank)
}

/** A hit's place in one retriever's candidates, or null when that retriever did not return it (or did not run). */
export function rankIn(hit: Hit, retriever: Retriever): number | null {
  return hit.ranks?.[retriever] ?? null
}

/** Fusion ranks passages, not documents: the same document can win with different passages in different modes. */
export function passageOf(hit: Hit): string {
  return `${hit.document_id}#${hit.ordinal}`
}

// Metadata is whatever the writer of a document sent, so each field is read as text or not at all. tools/seed.py
// records the file a section came from, the document's name and the section's heading.
function text(hit: Hit, field: string): string {
  const value = hit.metadata[field]
  return typeof value === 'string' ? value : ''
}

/** The file the passage came from, or nothing when the corpus does not say. */
export function sourceOf(hit: Hit): string {
  return text(hit, 'source')
}

/**
 * A name short enough for a narrow row. Titles in the demo corpus are "document: section", and several sections of one
 * document share a long first half, so the section goes first and the document under it. Any other corpus gets its
 * title as it is.
 */
export function labelOf(hit: Hit): { name: string; within: string } {
  const section = text(hit, 'section')
  return section === '' ? { name: hit.title, within: '' } : { name: section, within: text(hit, 'document') }
}
