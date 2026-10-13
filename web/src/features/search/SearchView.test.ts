// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '@/shared/api/queries'
import { found, held, hit, json, modeOf, network, problem } from '@/test/network'
import { at, input, open } from '@/test/page'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
})

/** With the clock held still: lets promises, the router and the query cache's zero-delay timers run to rest. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await vi.advanceTimersByTimeAsync(0)
}

const fusion = hit('fusion', {
  title: 'ADR 3. Reciprocal rank fusion: Decision',
  snippet: 'each retriever contributes its «rank», nothing else',
  metadata: { source: 'docs/adr/0003.md' },
  score: 0.1603,
  ranks: { lexical: 3, vector: 2 },
})
const lease = hit('lease', { title: 'Glossary: Lease', score: 0.0909, ranks: { vector: 1 } })

const status = () => screen.getByRole('status')
const results = () => screen.getByRole('list', { name: 'Results' })

describe('the search view', () => {
  it('asks for a query, offers examples and sends nothing while the box is empty', async () => {
    const calls = network(() => found('hybrid', []))

    await open('/')

    expect(await screen.findByRole('heading', { level: 1, name: 'Search' })).toBeTruthy()
    expect(screen.getByText(/Type a query to search/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '0.6003' })).toBeTruthy()
    expect(status().textContent).toBe('')
    expect(calls).toHaveLength(0)
  })

  it('searches once after the typing stops, puts the query in the address and shows each hit with its ranks', async () => {
    const calls = network(() => found('hybrid', [fusion, lease]))
    const user = userEvent.setup()
    const router = await open('/')

    await user.type(await screen.findByRole('searchbox', { name: 'Query' }), 'rank fusion')

    const rows = within(await screen.findByRole('list', { name: 'Results' })).getAllByRole('listitem')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toEqual({ query: 'rank fusion', mode: 'hybrid', k: 10, explain: true })
    expect(router.currentRoute.value.fullPath).toBe('/?q=rank+fusion')
    expect(status().textContent).toBe('2 results from hybrid search in 12.3 ms.')
    expect(rows).toHaveLength(2)

    const first = within(at(rows, 0))
    expect(first.getByRole('heading', { name: 'ADR 3. Reciprocal rank fusion: Decision' })).toBeTruthy()
    expect(first.getByText('docs/adr/0003.md')).toBeTruthy()
    expect(first.getByText('rank', { selector: 'mark' })).toBeTruthy()
    expect(first.getByText('Lexical').nextElementSibling?.textContent).toContain('rank 3')
    expect(first.getByText('Vector').nextElementSibling?.textContent).toContain('rank 2')
    expect(first.getByText('0.1603')).toBeTruthy()
    // Found by one retriever only: the other says so instead of showing a rank.
    expect(within(at(rows, 1)).getByText('not in its top 50')).toBeTruthy()
  })

  it('says which passage of a long section a result is', async () => {
    network(() => found('hybrid', [{ ...fusion, ordinal: 2 }, lease]))

    await open('/?q=fusion')

    const rows = within(await screen.findByRole('list', { name: 'Results' })).getAllByRole('listitem')
    expect(within(at(rows, 0)).getByText('docs/adr/0003.md, passage 3')).toBeTruthy()
    // A document that came without a source shows none, and its title is enough.
    expect(at(rows, 1).textContent).not.toContain('passage')
  })

  it('waits 300 ms after the last key before it searches, and Enter does not wait', async () => {
    const calls = network(() => found('hybrid', [fusion]))
    await open('/')
    const box = await screen.findByRole('searchbox', { name: 'Query' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    await user.type(box, 'fusion')
    await vi.advanceTimersByTimeAsync(299)
    await settle()
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({ query: 'fusion' })

    await user.type(box, ' rank{Enter}')
    await settle()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body).toMatchObject({ query: 'fusion rank' })
    // The timer that Enter overtook does not send the same query a second time.
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    expect(calls).toHaveLength(2)
  })

  it('puts focus in the query box when an example is chosen: the button that had it is gone', async () => {
    network(() => found('hybrid', [fusion]))
    const user = userEvent.setup()
    await open('/')
    const example = await screen.findByRole('button', { name: '0.6003' })

    example.focus()
    await user.keyboard('{Enter}')

    await screen.findByRole('heading', { name: fusion.title })
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Query' }))
  })

  it('puts focus in the query box when a search is repeated: the button that had it is gone', async () => {
    let refuse = true
    network(() => (refuse ? problem(503, 'Not ready', 'the database is unreachable') : found('hybrid', [fusion])))
    const user = userEvent.setup()
    await open('/?q=fusion')
    const again = within(await screen.findByRole('alert')).getByRole('button', { name: 'Search again' })
    const box = screen.getByRole('searchbox', { name: 'Query' })

    // The failure, and its button, go as soon as the search starts again, whatever comes of it.
    again.focus()
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(box)
    await screen.findByRole('alert')
    expect(document.activeElement).toBe(box)

    refuse = false
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Search again' }))

    await screen.findByRole('heading', { name: fusion.title })
    expect(document.activeElement).toBe(box)
  })

  it('does not describe an empty result of the previous mode in the words of the mode that is loading', async () => {
    const next = held<Response>()
    network((call) => (modeOf(call) === 'lexical' ? found('lexical', []) : next.promise))
    const user = userEvent.setup()
    await open('/?q=nothing+here&mode=lexical')
    await screen.findByRole('heading', { name: 'Nothing matched' })

    await user.click(screen.getByRole('radio', { name: /Vector/ }))

    await waitFor(() => expect(status().textContent).toBe('Searching.'))
    // Nothing is known about the vector search yet: it must not be said to have found nothing.
    expect(screen.queryByRole('heading', { name: 'Nothing matched' })).toBeNull()
    expect(screen.queryByText(/No passage in the collection has a vector yet/)).toBeNull()

    next.release(found('vector', [lease]))
    expect(await screen.findByRole('heading', { name: 'Glossary: Lease' })).toBeTruthy()
  })

  it('keeps describing the previous results as what they are while another mode loads', async () => {
    const next = held<Response>()
    network((call) =>
      modeOf(call) === 'lexical' ? found('lexical', [{ ...fusion, ranks: { lexical: 1 } }]) : next.promise,
    )
    const user = userEvent.setup()
    await open('/?q=fusion&mode=lexical')
    await screen.findByRole('heading', { name: fusion.title })
    expect(screen.getByText('not run')).toBeTruthy()

    await user.click(screen.getByRole('radio', { name: /Hybrid/ }))

    await waitFor(() => expect(status().textContent).toBe('Searching.'))
    // The row on screen still comes from the lexical search, in which the vector retriever was not asked.
    expect(screen.getByText('not run')).toBeTruthy()
    expect(screen.queryByText('not in its top 50')).toBeNull()

    next.release(found('hybrid', [fusion]))
    await waitFor(() => expect(screen.queryByText('not run')).toBeNull())
    expect(status().textContent).toBe('1 result from hybrid search in 12.3 ms.')
  })

  it('runs a search from the address alone, in the mode the address names', async () => {
    const calls = network(() => found('lexical', [{ ...fusion, ranks: { lexical: 1 } }]))

    await open('/?q=fusion&mode=lexical')

    const box = await screen.findByRole('searchbox', { name: 'Query' })
    expect(input(box).value).toBe('fusion')
    expect(input(screen.getByRole('radio', { name: /Lexical/ })).checked).toBe(true)
    await screen.findByRole('heading', { name: fusion.title })
    expect(calls[0]?.body).toMatchObject({ query: 'fusion', mode: 'lexical' })
    // The vector retriever was not asked, which is not the same as not finding the passage.
    expect(screen.getByText('not run')).toBeTruthy()
  })

  it('treats a mode it does not know, or a repeated query, as absent', async () => {
    const calls = network(() => found('hybrid', [fusion]))

    await open('/?q=fusion&mode=semantic')
    await screen.findByRole('heading', { name: fusion.title })

    expect(calls.map(modeOf)).toEqual(['hybrid'])
    cleanup()
    await open('/?q=a&q=b')
    expect(input(await screen.findByRole('searchbox', { name: 'Query' })).value).toBe('')
  })

  it('switches mode from the keyboard and records it in the address', async () => {
    const calls = network((call) => found(modeOf(call), [fusion]))
    const user = userEvent.setup()
    const router = await open('/?q=fusion')
    await screen.findByRole('heading', { name: fusion.title })

    await user.click(screen.getByRole('radio', { name: /Hybrid/ }))
    await user.keyboard('{ArrowRight}')

    await waitFor(() => expect(router.currentRoute.value.query).toEqual({ q: 'fusion', mode: 'lexical' }))
    await waitFor(() => expect(status().textContent).toContain('from lexical search'))
    expect(calls.map(modeOf)).toEqual(['hybrid', 'lexical'])
  })

  it('keeps the previous results on screen and says it is searching while the next ones load', async () => {
    const next = held<Response>()
    network((call) => (modeOf(call) === 'hybrid' ? found('hybrid', [fusion]) : next.promise))
    const user = userEvent.setup()
    await open('/?q=fusion')
    await screen.findByRole('heading', { name: fusion.title })

    await user.click(screen.getByRole('radio', { name: /Vector/ }))

    await waitFor(() => expect(status().textContent).toBe('Searching.'))
    expect(screen.getByRole('heading', { name: fusion.title })).toBeTruthy()
    expect(results().getAttribute('aria-busy')).toBe('true')

    next.release(found('vector', [lease]))

    expect(await screen.findByRole('heading', { name: 'Glossary: Lease' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: fusion.title })).toBeNull()
    expect(results().getAttribute('aria-busy')).toBe('false')
    expect(status().textContent).toBe('1 result from vector search in 12.3 ms.')
  })

  it('cancels the request for a query that has been replaced', async () => {
    const calls = network((call) =>
      modeOf(call) === 'hybrid' ? new Promise<Response>(() => undefined) : found('lexical', [fusion]),
    )
    const user = userEvent.setup()
    await open('/?q=fusion')
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.signal?.aborted).toBe(false)

    await user.click(screen.getByRole('radio', { name: /Lexical/ }))

    await screen.findByRole('heading', { name: fusion.title })
    expect(calls[0]?.signal?.aborted).toBe(true)
    expect(calls[1]?.signal?.aborted).toBe(false)
  })

  it('says why the lexical retriever found nothing, and what to try', async () => {
    network(() => found('lexical', []))

    await open('/?q=throttle+greedy+visitors&mode=lexical')

    expect(await screen.findByRole('heading', { name: 'Nothing matched' })).toBeTruthy()
    expect(screen.getByText(/needs at least one word in common/)).toBeTruthy()
    expect(status().textContent).toBe('No results.')
    expect(screen.queryByRole('list', { name: 'Results' })).toBeNull()
  })

  it('explains a rate limit and searches again when asked', async () => {
    let refuse = true
    const calls = network(() =>
      refuse
        ? problem(429, 'Too many requests', 'this address is sending requests faster than the proxy allows')
        : found('hybrid', [fusion]),
    )
    const user = userEvent.setup()

    await open('/?q=fusion')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'Too many searches' })).toBeTruthy()
    expect(alert.textContent).toContain('Wait a few seconds, then search again.')
    expect(status().textContent).toBe('The search failed.')

    refuse = false
    await user.click(within(alert).getByRole('button', { name: 'Search again' }))

    expect(await screen.findByRole('heading', { name: fusion.title })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('shows the title and detail of a server error as the API sent them', async () => {
    network(() => problem(503, 'Not ready', 'the database is unreachable'))

    await open('/?q=fusion')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The search service answered 503: Not ready' })).toBeTruthy()
    expect(alert.textContent).toContain('The database is unreachable. Search again in a moment.')
  })

  it('says so when the server sends an error with no detail', async () => {
    network(() => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }))

    await open('/?q=fusion')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The search service answered 502: Bad Gateway' })).toBeTruthy()
    expect(alert.textContent).toContain('It gave no detail. Search again in a moment.')
  })

  it('shows a refusal that is not about load, with what the server said', async () => {
    network(() => problem(404, 'Not found', 'this origin serves search and stats for one collection'))

    await open('/?q=fusion')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The server refused the search (404 Not found)' })).toBeTruthy()
    expect(alert.textContent).toContain('This origin serves search and stats for one collection.')
  })

  it('tells a network failure apart from an answer', async () => {
    network(() => {
      throw new TypeError('Failed to fetch')
    })

    await open('/?q=fusion')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'No answer from the server' })).toBeTruthy()
    expect(alert.textContent).toContain('Check the connection, then search again.')
  })

  it('does not render an answer it cannot parse', async () => {
    network(() => json({ mode: 'hybrid', hits: [{ id: 'fusion' }] }))

    await open('/?q=fusion')

    const alert = await screen.findByRole('alert')
    expect(
      within(alert).getByRole('heading', { name: 'The answer is not in the shape this page expects' }),
    ).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Results' })).toBeNull()
  })

  it('runs an example query when its button is pressed', async () => {
    const calls = network(() => found('hybrid', [fusion]))
    const user = userEvent.setup()
    const router = await open('/')

    await user.click(await screen.findByRole('button', { name: '0.6003' }))

    await screen.findByRole('heading', { name: fusion.title })
    expect(router.currentRoute.value.query).toEqual({ q: '0.6003' })
    expect(calls[0]?.body).toMatchObject({ query: '0.6003' })
    expect(input(await screen.findByRole('searchbox', { name: 'Query' })).value).toBe('0.6003')
  })

  it('clears the results when the query is erased', async () => {
    network(() => found('hybrid', [fusion]))
    const user = userEvent.setup()
    const router = await open('/?q=fusion')
    await screen.findByRole('heading', { name: fusion.title })

    await user.clear(screen.getByRole('searchbox', { name: 'Query' }))

    expect(await screen.findByText(/Type a query to search/)).toBeTruthy()
    expect(router.currentRoute.value.fullPath).toBe('/')
    expect(screen.queryByRole('list', { name: 'Results' })).toBeNull()
  })
})
