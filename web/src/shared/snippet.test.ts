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
    expect(parts('«open»closed«again»»')).toEqual([
      { text: 'open', match: true },
      { text: 'closed', match: false },
      { text: 'again', match: true },
      { text: '»', match: false },
    ])
    expect(parts('dangling «start')).toEqual([{ text: 'dangling «start', match: false }])
  })

  it('leaves guillemets that belong to the document alone: a match is one token, with no space in it', () => {
    // A real snippet from the demo corpus, whose documentation describes the markers themselves. ts_headline wraps
    // single tokens, so a pair with a space inside is the document's own punctuation.
    const snippet = 'The API «marks» «matches» with « and » and does not «escape» anything.'

    expect(parts(snippet)).toEqual([
      { text: 'The API ', match: false },
      { text: 'marks', match: true },
      { text: ' ', match: false },
      { text: 'matches', match: true },
      { text: ' with « and » and does not ', match: false },
      { text: 'escape', match: true },
      { text: ' anything.', match: false },
    ])
    expect(parts('il a dit « bonjour » et «rien»')).toEqual([
      { text: 'il a dit « bonjour » et ', match: false },
      { text: 'rien', match: true },
    ])
  })

  it('leaves an empty pair as the text it is', () => {
    expect(parts('a «» b')).toEqual([{ text: 'a «» b', match: false }])
  })
})
