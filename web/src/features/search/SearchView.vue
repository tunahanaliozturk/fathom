<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'

import type { Mode } from '@/shared/api/modes'
import { useSearch } from '@/shared/api/queries'
import { passageOf } from '@/shared/ranking'
import ExampleQueries from '@/shared/ui/ExampleQueries.vue'
import FailureNote from '@/shared/ui/FailureNote.vue'
import ModePicker from '@/shared/ui/ModePicker.vue'
import QueryBox from '@/shared/ui/QueryBox.vue'

import ResultRow from './ResultRow.vue'

// The address is the state: both props come from the query string (router.ts), and every change goes back into it.
const props = defineProps<{ q: string; mode: Mode }>()

const router = useRouter()
const { data, error, isFetching, isPlaceholderData, refetch } = useSearch(
  () => props.q,
  () => props.mode,
)

function address(q: string, mode: Mode) {
  return { name: 'search', query: { ...(q === '' ? {} : { q }), ...(mode === 'hybrid' ? {} : { mode }) } }
}

// Typing replaces the entry, so Back leaves the search instead of undoing it a letter at a time. Picking a mode or
// an example is a step a person took, and gets an entry of its own.
const typed = (q: string) => void router.replace(address(q, props.mode))
const picked = (q: string, mode: Mode) => void router.push(address(q, mode))

const hits = computed(() => data.value?.hits ?? [])

// Drawn and announced: this line is a live region, and it is the only loading indicator there is.
const status = computed(() => {
  if (props.q === '') return ''
  if (isFetching.value) return 'Searching.'
  if (error.value !== null) return 'The search failed.'
  const found = data.value
  if (found === undefined) return ''
  if (found.hits.length === 0) return 'No results.'
  const count = found.hits.length === 1 ? '1 result' : `${found.hits.length} results`
  return `${count} from ${found.mode} search in ${found.took_ms.toFixed(1)} ms.`
})
</script>

<template>
  <h1 tabindex="-1">Search</h1>
  <div class="controls">
    <QueryBox :query="q" @search="typed" />
    <ModePicker :mode="mode" @pick="(next) => picked(q, next)" />
  </div>

  <p class="status" role="status">{{ status }}</p>

  <div v-if="q === ''" class="idle">
    <p>
      Type a query to search fathom's documentation. Each result shows where the lexical and the vector retriever ranked
      it, which is all that fusion looks at.
    </p>
    <ExampleQueries @pick="(query) => picked(query, mode)" />
  </div>
  <FailureNote v-else-if="error !== null" :failure="error" @retry="() => refetch()" />
  <div v-else-if="data !== undefined && hits.length === 0" class="nothing">
    <h2>Nothing matched</h2>
    <p v-if="mode === 'lexical'">
      The lexical retriever needs at least one word in common with a document, after stemming. Try the vector or the
      hybrid retriever for the same query.
    </p>
    <p v-else>No passage in the collection has a vector yet, and none shares a word with the query.</p>
  </div>
  <ol
    v-else-if="data !== undefined"
    :class="['results', { stale: isPlaceholderData }]"
    :aria-busy="isFetching"
    aria-label="Results"
  >
    <ResultRow v-for="(hit, index) in hits" :key="passageOf(hit)" :hit="hit" :position="index + 1" :mode="mode" />
  </ol>
</template>

<style scoped>
h1 {
  font-size: 1.5rem;
  margin-bottom: 1rem;
}

.controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 1rem 2rem;
}

.status {
  min-height: 1.5rem;
  margin: 1.25rem 0 0.5rem;
  font-size: 0.875rem;
  color: var(--ink-soft);
}

.idle {
  display: grid;
  gap: 1.5rem;
}

.idle > p {
  max-width: 46rem;
}

.nothing {
  display: grid;
  gap: 0.5rem;
  max-width: 40rem;
  padding: 1rem 0;
  border-top: 1px solid var(--rule);
}

.nothing h2 {
  font-size: 1.0625rem;
}

.results {
  border-bottom: 1px solid var(--rule);
  transition: opacity 120ms ease-out;
}

/* The previous query's results, kept while the next ones load. */
.stale {
  opacity: 0.55;
}

@media (max-width: 56rem) {
  .controls {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
