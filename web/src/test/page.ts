// Mounts the routed part of the page at an address, with a router that keeps its history in memory. The routes, the
// reading of the query string and the views are the real ones.

import { render } from '@testing-library/vue'
import { createMemoryHistory, RouterView, type Router } from 'vue-router'

import { buildRouter } from '@/router'

export async function open(address: string): Promise<Router> {
  const router = buildRouter(createMemoryHistory())
  await router.push(address)
  render(RouterView, { global: { plugins: [router] } })
  return router
}

/** The element as the input it is. Testing Library hands back HTMLElement; a test that reads `value` needs more. */
export function input(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error(`expected an input, found <${element.localName}>`)
  return element
}

/** The item at `index`, or a failed test: an index into an array may be past its end. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`nothing at index ${index} of ${items.length}`)
  return item
}
