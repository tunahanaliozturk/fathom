// Server data lives in the query cache and nowhere else. The cache is passed to each useQuery call instead of being
// installed as a plugin, so the library stays out of the entry chunk and loads with the first view that needs it.

import { keepPreviousData, QueryClient, useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'

import { search, stats } from './fathom'
import type { Mode } from './modes'

export const queryClient = new QueryClient({
  defaultOptions: {
    // No automatic retry: a refused search says why, and the person decides whether to send it again.
    queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false },
  },
})

/**
 * Hits for the query and mode in the address. A new key cancels the request for the old one (the fetch gets the
 * query's AbortSignal), and the old hits stay as placeholder data until the new ones arrive.
 */
export function useSearch(query: MaybeRefOrGetter<string>, mode: MaybeRefOrGetter<Mode>) {
  return useQuery(
    {
      queryKey: ['search', computed(() => toValue(query)), computed(() => toValue(mode))] as const,
      queryFn: ({ queryKey, signal }) => search(queryKey[1], queryKey[2], signal),
      enabled: computed(() => toValue(query) !== ''),
      placeholderData: keepPreviousData,
    },
    queryClient,
  )
}

const POLL = 2000

/** Counts for the collection. Polled only while chunks are still waiting for a vector. */
export function useStats() {
  return useQuery(
    {
      queryKey: ['stats'] as const,
      queryFn: ({ signal }) => stats(signal),
      refetchInterval: (query) => ((query.state.data?.pending ?? 0) > 0 ? POLL : false),
    },
    queryClient,
  )
}
