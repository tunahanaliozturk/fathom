import {
  createRouter,
  START_LOCATION,
  type RouteLocationNormalized,
  type Router,
  type RouteRecordRaw,
  type RouterHistory,
} from 'vue-router'

import { MODES, QUERY_MAX, type Mode } from '@/shared/api/modes'

// The query and the mode are the address, so a search is a link. The address bar is input like any other: anything
// that is not one string, or not a known mode, is read as if it were absent.

function queryOf(route: RouteLocationNormalized): string {
  const value = route.query.q
  return typeof value === 'string' ? value.trim().slice(0, QUERY_MAX) : ''
}

// What a browser says when the file behind a dynamic import is not there: Chrome and Firefox, then Safari.
const SCRIPT_GONE = /dynamically imported module|Importing a module script failed/i
const RELOADED_FOR = 'fathom:reloaded-for'

/**
 * Whether to load the page again to reach `address`: yes the first time, no if that was already tried and the file is
 * still missing. The memory has to outlive the reload, hence session storage; where storage is refused the answer is
 * no, because a reload that cannot be remembered could repeat for ever.
 */
function mayReloadFor(address: string): boolean {
  try {
    if (sessionStorage.getItem(RELOADED_FOR) === address) return false
    sessionStorage.setItem(RELOADED_FOR, address)
    return true
  } catch {
    return false
  }
}

function forgetReload(): void {
  try {
    sessionStorage.removeItem(RELOADED_FOR)
  } catch {
    // Nothing was remembered where storage is refused.
  }
}

function modeOf(route: RouteLocationNormalized): Mode {
  return MODES.find((mode) => mode === route.query.mode) ?? 'hybrid'
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'search',
    component: () => import('@/features/search/SearchView.vue'),
    props: (route) => ({ q: queryOf(route), mode: modeOf(route) }),
  },
  {
    path: '/compare',
    name: 'compare',
    component: () => import('@/features/compare/CompareView.vue'),
    props: (route) => ({ q: queryOf(route) }),
  },
  { path: '/:rest(.*)*', redirect: { name: 'search' } },
]

/**
 * The history is the caller's choice: the address bar in the page (main.ts), memory in a test. So is what "load the
 * page again" means.
 */
export function buildRouter(
  history: RouterHistory,
  reload: (address: string) => void = (address) => location.assign(address),
): Router {
  const router = createRouter({ history, routes })
  // Every view is a file of its own, named after its content. A tab left open across a deploy still has the old
  // names, and the navigation that needs one of them fails. Loading the page again at the address it was going to
  // fetches the new build; without this the click would simply do nothing.
  router.onError((error, to) => {
    if (error instanceof Error && SCRIPT_GONE.test(error.message) && mayReloadFor(to.fullPath)) reload(to.fullPath)
  })
  router.afterEach((to, from, failure) => {
    if (failure === undefined) forgetReload()
    const query = queryOf(to)
    document.title = query === '' ? 'fathom' : `${query} | fathom`
    if (from === START_LOCATION || to.path === from.path) return
    // A new page: move focus to its heading, or a screen reader stays where the old page was.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('h1')?.focus())
  })
  return router
}
