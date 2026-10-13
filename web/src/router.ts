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
  return typeof value === 'string' ? value.slice(0, QUERY_MAX) : ''
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

/** The history is the caller's choice: the address bar in the page (main.ts), memory in a test. */
export function buildRouter(history: RouterHistory): Router {
  const router = createRouter({ history, routes })
  router.afterEach((to, from) => {
    const query = queryOf(to)
    document.title = query === '' ? 'fathom' : `${query} | fathom`
    if (from === START_LOCATION || to.path === from.path) return
    // A new page: move focus to its heading, or a screen reader stays where the old page was.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('h1')?.focus())
  })
  return router
}
