import { describe, expect, it } from 'vitest'

import type { Hit } from '@/shared/api/fathom'
import { contribution, labelOf, sourceOf } from '@/shared/ranking'

import { curve, links } from './flow'

function hit(id: string, ranks: Record<string, number>, ordinal = 0): Hit {
  return { document_id: id, ordinal, title: id, snippet: '', metadata: {}, score: 0, ranks }
}

describe('links', () => {
  const lexical = [hit('a', { lexical: 1 }), hit('b', { lexical: 2 }), hit('c', { lexical: 3 })]

  it('joins a fused result to the row it holds in the retriever list', () => {
    const fused = [hit('c', { lexical: 3, vector: 1 }), hit('a', { lexical: 1, vector: 9 })]

    expect(links('lexical', lexical, fused)).toEqual([
      { passage: 'c#0', from: 2, to: 0 },
      { passage: 'a#0', from: 0, to: 1 },
    ])
  })

  it('starts from the lane under the list when the retriever ranked the result below its visible rows', () => {
    const fused = [hit('z', { lexical: 23, vector: 1 })]

    expect(links('lexical', lexical, fused)).toEqual([{ passage: 'z#0', from: 10, to: 0 }])
  })

  it('draws nothing for a result the retriever never returned', () => {
    const fused = [hit('z', { vector: 1 })]

    expect(links('lexical', lexical, fused)).toEqual([])
  })

  it('tells two passages of one document apart', () => {
    // The lexical list shows the first passage of the document; fusion picked its second, which lexical ranked 14th.
    const fused = [hit('a', { lexical: 14, vector: 2 }, 1)]

    expect(links('lexical', lexical, fused)).toEqual([{ passage: 'a#1', from: 10, to: 0 }])
  })
})

describe('curve', () => {
  it('runs from the middle of one row to the middle of the other, towards the fused list', () => {
    expect(curve({ passage: 'p', from: 2, to: 0 }, 'left')).toBe('M 0 25 C 50 25, 50 5, 100 5')
    expect(curve({ passage: 'p', from: 2, to: 0 }, 'right')).toBe('M 100 25 C 50 25, 50 5, 0 5')
  })
})

describe('what a rank adds', () => {
  it('is one over ten plus the rank, the fusion the service runs', () => {
    // 3rd in one list and 2nd in the other: the score the API returns for such a hit is 0.16025641...
    expect(contribution(3) + contribution(2)).toBeCloseTo(1 / 13 + 1 / 12, 12)
    expect(contribution(1)).toBeCloseTo(0.0909, 4)
  })
})

describe('labels', () => {
  it('puts the section first when the corpus names one, and falls back to the title', () => {
    const sectioned: Hit = {
      ...hit('a', {}),
      title: 'ADR 5. Embedding happens after the write: Consequences',
      metadata: {
        source: 'docs/adr/0005.md',
        document: 'ADR 5. Embedding happens after the write',
        section: 'Consequences',
      },
    }

    expect(labelOf(sectioned)).toEqual({ name: 'Consequences', within: 'ADR 5. Embedding happens after the write' })
    expect(sourceOf(sectioned)).toBe('docs/adr/0005.md')
    expect(labelOf(hit('b', {}))).toEqual({ name: 'b', within: '' })
    // Metadata is free-form: a field of the wrong type is ignored, not shown.
    expect(sourceOf({ ...hit('c', {}), metadata: { source: 42 } })).toBe('')
  })
})
