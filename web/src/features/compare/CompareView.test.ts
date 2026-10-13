// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '@/shared/api/queries'
import { found, hit, modeOf, network, problem, type Call } from '@/test/network'
import { open } from '@/test/page'

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
})

const section = (document: string, name: string) => ({ document, section: name, source: 'docs/x.md' })

// One query, as each mode answers it. `crash` is ranked high by both; `lease` only by the vector retriever;
// `machine` only by the lexical one; `far` is in the fused list on the strength of a lexical rank below the first ten.
const crash = hit('crash', { title: 'ADR 5: Consequences', metadata: section('ADR 5', 'Consequences') })
const lease = hit('lease', { title: 'Glossary: Lease', metadata: section('Glossary', 'Lease') })
const machine = hit('machine', { title: 'Laptop run: Machine', metadata: section('Laptop run', 'Machine') })
const far = hit('far', { title: 'ADR 1: Context', metadata: section('ADR 1', 'Context') })

// An answer that replaces the usual one for a mode. A function, because a Response can be read only once.
const answers: Record<string, () => Response> = {}
function threeWays(call: Call): Response {
  const lists = {
    lexical: [
      { ...machine, ranks: { lexical: 1 } },
      { ...crash, ranks: { lexical: 3 } },
    ],
    vector: [
      { ...lease, ranks: { vector: 1 } },
      { ...crash, ranks: { vector: 2 } },
      { ...far, ranks: { vector: 4 } },
    ],
    hybrid: [
      { ...crash, score: 1 / 13 + 1 / 12, ranks: { lexical: 3, vector: 2 }, snippet: 'its batch is «claimed» again' },
      { ...far, score: 1 / 24 + 1 / 14, ranks: { lexical: 14, vector: 4 } },
      { ...lease, score: 1 / 11, ranks: { vector: 1 } },
    ],
  }
  const mode = modeOf(call)
  return answers[mode]?.() ?? found(mode, lists[mode === 'lexical' || mode === 'vector' ? mode : 'hybrid'])
}

afterEach(() => {
  for (const mode of Object.keys(answers)) Reflect.deleteProperty(answers, mode)
})

const column = (name: string) => within(screen.getByRole('region', { name }))

/**
 * A row's accessible name: its parts in order, separated by commas. Spacing is left open, because jsdom and a browser
 * do not join the text of neighbouring elements the same way.
 */
const named = (...parts: string[]): RegExp =>
  new RegExp(`^${parts.map((part) => part.replaceAll(' ', String.raw`\s*`)).join(String.raw`\s*,\s*`)}$`)

describe('the comparison view', () => {
  it('waits for a query and offers the examples', async () => {
    const calls = network(threeWays)

    await open('/compare')

    expect(await screen.findByRole('heading', { level: 1, name: 'Compare retrievers' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'reciprocal rank fusion k' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Fused' })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('runs the query in all three modes and lists each result under the retriever that found it', async () => {
    const calls = network(threeWays)

    await open('/compare?q=machine+dies')

    await screen.findByRole('region', { name: 'Fused' })
    expect(calls.map(modeOf).sort()).toEqual(['hybrid', 'lexical', 'vector'])
    const lexical = column('Lexical')
    expect(lexical.getAllByRole('button')).toHaveLength(2)
    expect(lexical.getByRole('button', { name: named('lexical rank 1', 'Machine', 'Laptop run') })).toBeTruthy()
    expect(lexical.getByRole('button', { name: named('lexical rank 3', 'Consequences', 'ADR 5') })).toBeTruthy()
    expect(column('Vector').getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('status').textContent).toBe(
      'Lexical returned 2 passages, vector 3 passages; 3 passages after fusion.',
    )
  })

  it('says in each fused row where the passage ranked in each retriever, or that one did not return it', async () => {
    network(threeWays)

    await open('/compare?q=machine+dies')

    await screen.findByRole('region', { name: 'Fused' })
    const fused = column('Fused')
    expect(fused.getAllByRole('button').map((row) => row.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ])
    for (const parts of [
      ['lexical rank 3', 'vector rank 2', 'fused rank 1', 'Consequences', 'ADR 5'],
      ['lexical rank 14', 'vector rank 4', 'fused rank 2', 'Context', 'ADR 1'],
      ['not returned by the lexical retriever', 'vector rank 1', 'fused rank 3', 'Lease', 'Glossary'],
    ]) {
      expect(fused.getByRole('button', { name: named(...parts) })).toBeTruthy()
    }
    // A lexical rank of 14 is below the rows that are shown, so the lexical list says where the line comes from.
    expect(column('Lexical').getByText('other passages, down to rank 50')).toBeTruthy()
    expect(column('Vector').queryByText('other passages, down to rank 50')).toBeNull()
  })

  it('works the first fused result out, and any other passage when its row is pressed', async () => {
    network(threeWays)
    const user = userEvent.setup()
    await open('/compare?q=machine+dies')

    const worked = within(await screen.findByRole('region', { name: 'How this passage was ranked' }))
    expect(worked.getByRole('heading', { name: 'ADR 5: Consequences' })).toBeTruthy()
    expect(worked.getByText('claimed', { selector: 'mark' })).toBeTruthy()
    expect(worked.getByRole('row', { name: 'Lexical 3 1 / (10 + 3) = 0.0769' })).toBeTruthy()
    expect(worked.getByRole('row', { name: 'Vector 2 1 / (10 + 2) = 0.0833' })).toBeTruthy()
    // The page's two terms add up to the score the API sent.
    expect(worked.getByRole('row', { name: 'Fused 1 0.1603' })).toBeTruthy()
    expect((1 / 13 + 1 / 12).toFixed(4)).toBe('0.1603')

    const leaseRow = column('Fused').getByRole('button', { name: /Lease/ })
    await user.click(leaseRow)

    expect(leaseRow.getAttribute('aria-pressed')).toBe('true')
    expect(worked.getByRole('heading', { name: 'Glossary: Lease' })).toBeTruthy()
    expect(worked.getByRole('row', { name: 'Lexical not in its top 50 0' })).toBeTruthy()
    expect(worked.getByRole('row', { name: 'Vector 1 1 / (10 + 1) = 0.0909' })).toBeTruthy()
    expect(worked.getByRole('row', { name: 'Fused 3 0.0909' })).toBeTruthy()
  })

  it('says what is known about a passage that one retriever listed and fusion left out', async () => {
    network(threeWays)
    const user = userEvent.setup()
    await open('/compare?q=machine+dies')
    await screen.findByRole('region', { name: 'Fused' })

    await user.click(column('Lexical').getByRole('button', { name: /Machine/ }))

    const worked = within(screen.getByRole('region', { name: 'How this passage was ranked' }))
    expect(worked.getByRole('heading', { name: 'Laptop run: Machine' })).toBeTruthy()
    expect(worked.getByText(/Lexical rank 1\.\s+Not in the fused top ten/)).toBeTruthy()
    expect(worked.queryByRole('table')).toBeNull()
  })

  it('marks the same passage in every list while one of its rows has the focus', async () => {
    network(threeWays)
    const user = userEvent.setup()
    await open('/compare?q=machine+dies')
    await screen.findByRole('region', { name: 'Fused' })
    const inLexical = column('Lexical').getByRole('button', { name: /Consequences/ })
    const inVector = column('Vector').getByRole('button', { name: /Lease/ })

    // The first fused result starts out pinned, so its rows are marked from the beginning.
    expect(inLexical.classList.contains('on')).toBe(true)
    expect(inVector.classList.contains('on')).toBe(false)

    await user.tab()
    await user.tab()
    expect(document.activeElement).toBe(column('Lexical').getByRole('button', { name: /Machine/ }))
    expect(inLexical.classList.contains('on')).toBe(false)

    await user.tab()
    expect(document.activeElement).toBe(inLexical)
    expect(
      column('Fused')
        .getByRole('button', { name: /Consequences/ })
        .classList.contains('on'),
    ).toBe(true)
    expect(
      column('Vector')
        .getByRole('button', { name: /Consequences/ })
        .classList.contains('on'),
    ).toBe(true)
  })

  it('marks a passage while the pointer is on one of its rows, and goes back to the pinned one after', async () => {
    network(threeWays)
    const user = userEvent.setup()
    await open('/compare?q=machine+dies')
    await screen.findByRole('region', { name: 'Fused' })
    const pinned = column('Fused').getByRole('button', { name: /Consequences/ })
    const lease = column('Vector').getByRole('button', { name: /Lease/ })

    await user.hover(lease)
    expect(lease.classList.contains('on')).toBe(true)
    expect(column('Fused').getByRole('button', { name: /Lease/ }).classList.contains('on')).toBe(true)
    expect(pinned.classList.contains('on')).toBe(false)

    await user.unhover(lease)
    expect(lease.classList.contains('on')).toBe(false)
    expect(pinned.classList.contains('on')).toBe(true)
    // Pointing is not choosing: the worked example is still the pinned passage.
    expect(pinned.getAttribute('aria-pressed')).toBe('true')
  })

  it('tells two passages of one section apart, and does not join them with a line', async () => {
    // The lexical retriever prefers the second passage of the section; fusion picked the first, which the lexical
    // retriever ranked fifth. They are different rows, and the lexical list says the fused one is further down.
    answers.lexical = () => found('lexical', [{ ...crash, ordinal: 1, ranks: { lexical: 2 } }])
    answers.hybrid = () => found('hybrid', [{ ...crash, score: 1 / 15 + 1 / 11, ranks: { lexical: 5, vector: 1 } }])
    network(threeWays)

    await open('/compare?q=machine+dies')

    await screen.findByRole('region', { name: 'Fused' })
    const inLexical = column('Lexical').getByRole('button', { name: /Consequences \(passage 2\)/ })
    expect(inLexical.classList.contains('on')).toBe(false)
    expect(
      column('Fused')
        .getByRole('button', { name: /Consequences/ })
        .classList.contains('on'),
    ).toBe(true)
    expect(column('Lexical').getByText('other passages, down to rank 50')).toBeTruthy()
  })

  it('says that the lexical retriever found nothing when no document shares a word with the query', async () => {
    answers.lexical = () => found('lexical', [])
    answers.hybrid = () => found('hybrid', [{ ...lease, score: 1 / 11, ranks: { vector: 1 } }])
    network(threeWays)

    await open('/compare?q=throttle+greedy+visitors')

    await screen.findByRole('region', { name: 'Fused' })
    expect(column('Lexical').getByText('No passage shares a word with this query.')).toBeTruthy()
    expect(column('Lexical').queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe(
      'Lexical returned 0 passages, vector 3 passages; 1 passage after fusion.',
    )
  })

  it('says so when neither retriever returns anything', async () => {
    for (const mode of ['lexical', 'vector', 'hybrid']) answers[mode] = () => found(mode, [])
    network(threeWays)

    await open('/compare?q=anything')

    expect(await screen.findByRole('heading', { name: 'Nothing matched' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('No results.')
  })

  it('shows one failure for the three requests and repeats only the one that failed', async () => {
    answers.vector = () => problem(503, 'Not ready', 'the database is unreachable')
    const calls = network(threeWays)
    const user = userEvent.setup()

    await open('/compare?q=machine+dies')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The search service answered 503: Not ready' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Fused' })).toBeNull()

    Reflect.deleteProperty(answers, 'vector')
    await user.click(within(alert).getByRole('button', { name: 'Search again' }))

    await screen.findByRole('region', { name: 'Fused' })
    expect(calls.map(modeOf).sort()).toEqual(['hybrid', 'lexical', 'vector', 'vector'])
  })

  it('follows the query as it is typed and keeps it in the address', async () => {
    const calls = network(threeWays)
    const user = userEvent.setup()
    const router = await open('/compare')

    await user.type(await screen.findByRole('searchbox', { name: 'Query' }), 'lease')

    await screen.findByRole('region', { name: 'Fused' })
    expect(router.currentRoute.value.fullPath).toBe('/compare?q=lease')
    expect(calls).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: '0.6003' }))
    await waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/compare?q=0.6003'))
  })
})
