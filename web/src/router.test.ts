// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '@/shared/api/queries'
import { found, network } from '@/test/network'
import { open } from '@/test/page'

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

afterEach(async () => {
  // A navigation moves focus in the next frame. Let that happen here, not in the middle of the next test.
  await frame()
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
})

describe('the router', () => {
  it('sends an address it does not know to the search view', async () => {
    const router = await open('/nowhere/at/all')

    expect(router.currentRoute.value.name).toBe('search')
    expect(await screen.findByRole('heading', { level: 1, name: 'Search' })).toBeTruthy()
  })

  it('names the page after the query', async () => {
    network(() => found('hybrid', []))

    const router = await open('/?q=rank+fusion')
    expect(document.title).toBe('rank fusion | fathom')

    await router.push('/compare')
    expect(document.title).toBe('fathom')
  })

  it('cuts a query from the address down to what the API accepts', async () => {
    const calls = network(() => found('hybrid', []))

    await open(`/?q=${'a'.repeat(1500)}`)

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.body).toMatchObject({ query: 'a'.repeat(1000) })
  })

  it('moves focus to the heading of a view that was navigated to, and leaves it alone on arrival', async () => {
    const router = await open('/')
    await screen.findByRole('heading', { level: 1, name: 'Search' })
    await frame()
    expect(document.activeElement).toBe(document.body)

    await router.push('/compare')
    const heading = await screen.findByRole('heading', { level: 1, name: 'Compare retrievers' })
    await frame()

    expect(document.activeElement).toBe(heading)
  })

  it('leaves focus where it is when only the query changes', async () => {
    network(() => found('hybrid', []))
    const router = await open('/')
    const box = await screen.findByRole('searchbox', { name: 'Query' })
    box.focus()

    await router.push('/?q=lease')
    await frame()

    expect(document.activeElement).toBe(box)
  })
})
