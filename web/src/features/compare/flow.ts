// The geometry of the comparison: which row of a retriever's list each fused result came from. Pure, so the picture
// can be tested without drawing it.

import { SHOWN, type Hit } from '@/shared/api/fathom'
import type { Retriever } from '@/shared/api/modes'
import { passageOf, rankIn } from '@/shared/ranking'

export interface Link {
  passage: string
  /** Row in the retriever's list, counted from 0. `SHOWN` means the lane under the list: ranked, but further down. */
  from: number
  /** Row in the fused list, counted from 0. */
  to: number
}

/**
 * One link per fused result that the retriever returned. A fused result the retriever ranked below its visible rows
 * (or that lost its row to another passage of the same document) starts from the lane; one it never returned has no
 * link at all, and that gap is the point of the picture.
 */
export function links(retriever: Retriever, found: Hit[], fused: Hit[]): Link[] {
  const rows = new Map(found.map((hit, row) => [passageOf(hit), row]))
  return fused.flatMap((hit, to) => {
    const passage = passageOf(hit)
    const row = rows.get(passage)
    if (row !== undefined) return [{ passage, from: row, to }]
    return rankIn(hit, retriever) === null ? [] : [{ passage, from: SHOWN, to }]
  })
}

/** Height of one row in the drawing's own units. The stylesheet sets the same rows in rem; only the ratio matters. */
export const ROW = 10
export const WIDTH = 100

/** An S-curve from the middle of one row to the middle of another, leaving and arriving level. */
export function curve(link: Link, side: 'left' | 'right'): string {
  const [start, end] = side === 'left' ? [0, WIDTH] : [WIDTH, 0]
  const y1 = link.from * ROW + ROW / 2
  const y2 = link.to * ROW + ROW / 2
  return `M ${start} ${y1} C ${WIDTH / 2} ${y1}, ${WIDTH / 2} ${y2}, ${end} ${y2}`
}
