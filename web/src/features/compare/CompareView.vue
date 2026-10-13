<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useRouter } from 'vue-router'

import type { Hit } from '@/shared/api/fathom'
import { useSearch } from '@/shared/api/queries'
import ExampleQueries from '@/shared/ui/ExampleQueries.vue'
import FailureNote from '@/shared/ui/FailureNote.vue'
import QueryBox from '@/shared/ui/QueryBox.vue'

import RankFlow from './RankFlow.vue'

const props = defineProps<{ q: string }>()

const router = useRouter()
const query = () => props.q

// The same three requests anyone can make by hand (requests.http, step 4). The hybrid one shares its cache entry with
// the search view, so arriving from there with the same query costs two requests, not three.
const lexical = useSearch(query, 'lexical')
const fused = useSearch(query, 'hybrid')
const vector = useSearch(query, 'vector')
const all = [lexical, fused, vector]

const address = (q: string) => ({ name: 'compare', query: q === '' ? {} : { q } })
const typed = (q: string) => void router.replace(address(q))
const picked = (q: string) => void router.push(address(q))

const failure = computed(() => all.map((one) => one.error.value).find((error) => error !== null) ?? null)
const fetching = computed(() => all.some((one) => one.isFetching.value))

// "Search again" is taken down, with the failure, as soon as the search starts again; focus goes to the query box,
// not to nowhere. Only the requests that failed are repeated.
const box = useTemplateRef<{ focus: () => void }>('box')

function retry(): void {
  box.value?.focus()
  for (const one of all) if (one.error.value !== null) void one.refetch()
}

// The three answers arrive one by one, and each query keeps its previous answer until its own arrives. A picture
// made of whatever is there would join one query's lexical list to another query's fused list. So the picture is
// built only from three answers to the same query, and until the next three are all in, the last one stays.
const settled = computed(() => all.every((one) => one.data.value !== undefined && !one.isPlaceholderData.value))
const stale = computed(() => !settled.value)

interface Lists {
  lexical: Hit[]
  fused: Hit[]
  vector: Hit[]
}

const lists = computed<Lists | null>((kept) => {
  const [l, f, v] = [lexical.data.value, fused.data.value, vector.data.value]
  if (!settled.value || l === undefined || f === undefined || v === undefined) return kept ?? null
  return { lexical: l.hits, fused: f.hits, vector: v.hits }
})

const count = (n: number): string => (n === 1 ? '1 passage' : `${n} passages`)

const status = computed(() => {
  if (props.q === '') return ''
  if (fetching.value) return 'Searching three ways.'
  if (failure.value !== null) return 'The search failed.'
  const found = lists.value
  if (found === null) return ''
  if (found.fused.length === 0) return 'No results.'
  return `Lexical returned ${count(found.lexical.length)}, vector ${count(found.vector.length)}; ${count(found.fused.length)} after fusion.`
})
</script>

<template>
  <h1 tabindex="-1">Compare retrievers</h1>
  <p class="lede">
    One query, run three ways. Left and right are what each retriever found by itself; the middle is what fusion made of
    the two. A line joins a fused result to the place it held in each list.
  </p>
  <QueryBox ref="box" :query="q" @search="typed" />

  <p class="status" role="status">{{ status }}</p>

  <FailureNote v-if="q !== '' && failure !== null" :failure="failure" @retry="retry" />
  <div v-else-if="q !== '' && lists !== null && settled && lists.fused.length === 0" class="nothing">
    <h2>Nothing matched</h2>
    <p>Neither retriever returned a passage for this query.</p>
  </div>
  <div v-else-if="q !== '' && lists !== null && lists.fused.length > 0" :class="{ stale }" :aria-busy="fetching">
    <RankFlow :lexical="lists.lexical" :fused="lists.fused" :vector="lists.vector" />
  </div>

  <!-- Under the picture once there is one, so the picture is what the page opens on. -->
  <ExampleQueries class="examples" @pick="picked" />
</template>

<style scoped>
h1 {
  font-size: 1.5rem;
}

.lede {
  max-width: 46rem;
  margin: 0.5rem 0 1.25rem;
  color: var(--ink-soft);
}

.examples {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--rule);
}

.status {
  min-height: 1.5rem;
  margin: 1.25rem 0 0.75rem;
  font-size: 0.875rem;
  color: var(--ink-soft);
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

.stale {
  opacity: 0.55;
  transition: opacity 120ms ease-out;
}
</style>
