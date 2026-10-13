import { describe, expect, it } from 'vitest'

import { parts } from './snippet'

describe('parts', () => {
  it('splits a snippet into text and matches, in order', () => {
    expect(parts('the «tower» was «designed» by')).toEqual([
      { text: 'the ', match: false },
      { text: 'tower', match: true },
      { text: ' was ', match: false },
      { text: 'designed', match: true },
      { text: ' by', match: false },
    ])
  })

  it('gives one plain part for a snippet with no match, and none for an empty one', () => {
    expect(parts('nothing marked')).toEqual([{ text: 'nothing marked', match: false }])
    expect(parts('')).toEqual([])
  })

  it('marks only the innermost pair when markers are nested, and keeps the rest as text', () => {
    expect(parts('a «b «c» d» e')).toEqual([
      { text: 'a «b ', match: false },
      { text: 'c', match: true },
      { text: ' d» e', match: false },
    ])
  })

  it('leaves a marker that never closes, or closes twice, in the text', () => {
    expect(parts('«open and »closed« again»»')).toEqual([
      { text: 'open and ', match: true },
      { text: 'closed', match: false },
      { text: ' again', match: true },
      { text: '»', match: false },
    ])
    expect(parts('dangling «start')).toEqual([{ text: 'dangling «start', match: false }])
  })

  it('drops an empty match instead of producing an empty mark', () => {
    expect(parts('a «» b')).toEqual([
      { text: 'a ', match: false },
      { text: ' b', match: false },
    ])
  })
})
