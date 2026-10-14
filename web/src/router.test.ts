// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'

import { queryClient } from '@/shared/api/queries'
import { found, network } from '@/test/network'
import { input, open } from '@/test/page'

import { buildRouter } from './router'

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

afterEach(async () => {
  // A navigation moves focus in the next frame. Let that happen here, not in the middle of the next test.
  await frame()
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

const GONE = 'Failed to fetch dynamically imported module: http://localhost/assets/CompareView-old.js'

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

  it('reads a query of nothing but spaces as no query, and drops the spaces around one', async () => {
    const calls = network(() => found('hybrid', []))

    await open('/?q=%20%20')
    expect(input(await screen.findByRole('searchbox', { name: 'Query' })).value).toBe('')
    expect(screen.getByText(/Type a query to search/)).toBeTruthy()
    expect(document.title).toBe('fathom')
    expect(calls).toHaveLength(0)

    cleanup()
    await open('/?q=%20lease%20')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.body).toMatchObject({ query: 'lease' })
    expect(document.title).toBe('lease | fathom')
  })

  it('loads the page again, once, when the script of a view is no longer on the server', async () => {
    // What a tab left open across a deploy runs into: the old build's file names are gone.
    const reload = vi.fn()
    const router = buildRouter(createMemoryHistory(), reload)
    router.addRoute({ path: '/gone', component: () => Promise.reject(new TypeError(GONE)) })
    await router.push('/')

    await router.push('/gone?q=lease').catch(() => undefined)
    expect(reload.mock.calls).toEqual([['/gone?q=lease']])

    // The reload did not help (the file is still missing): do not go round again.
    await router.push('/gone?q=lease').catch(() => undefined)
    expect(reload).toHaveBeenCalledTimes(1)

    // A navigation that works means the page is whole again, and the next failure is a new one.
    await router.push('/compare')
    await router.push('/gone?q=lease').catch(() => undefined)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('does not reload for an error that is not a missing script', async () => {
    const reload = vi.fn()
    const router = buildRouter(createMemoryHistory(), reload)
    router.addRoute({ path: '/broken', component: () => Promise.reject(new RangeError('Maximum call stack size')) })
    await router.push('/')

    await router.push('/broken').catch(() => undefined)

    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload where the browser refuses storage, because it could not remember having done so', async () => {
    const refused = (): never => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refused)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(refused)
    const reload = vi.fn()
    const router = buildRouter(createMemoryHistory(), reload)
    router.addRoute({ path: '/gone', component: () => Promise.reject(new TypeError(GONE)) })

    // Ordinary navigation is not disturbed by the refusal either.
    await router.push('/')
    await router.push('/gone').catch(() => undefined)

    expect(router.currentRoute.value.path).toBe('/')
    expect(reload).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('reloads by sending the browser to the address, unless told another way', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    const router = buildRouter(createMemoryHistory())
    router.addRoute({ path: '/gone', component: () => Promise.reject(new TypeError(GONE)) })
    await router.push('/')

    await router.push('/gone?q=lease').catch(() => undefined)

    expect(assign.mock.calls).toEqual([['/gone?q=lease']])
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
