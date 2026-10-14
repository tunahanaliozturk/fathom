<script setup lang="ts">
import { computed } from 'vue'

import type { Hit } from '@/shared/api/fathom'
import { RETRIEVERS, type Retriever } from '@/shared/api/modes'
import { CANDIDATES, contribution, RRF_K, sourceOf } from '@/shared/ranking'
import SnippetText from '@/shared/ui/SnippetText.vue'

// `position` is null for a passage that one retriever listed and fusion left out of its first ten. For such a
// passage a null rank means only "not in that retriever's visible rows": the page was not told more.
const props = defineProps<{ hit: Hit; position: number | null; lexical: number | null; vector: number | null }>()

const LABEL: Record<Retriever, string> = { lexical: 'Lexical', vector: 'Vector' }

const terms = computed(() =>
  RETRIEVERS.map((retriever) => {
    const rank = props[retriever]
    return { retriever, label: LABEL[retriever], rank, adds: rank === null ? 0 : contribution(rank) }
  }),
)

const source = computed(() => sourceOf(props.hit))

// 1/13 is 0.0769 and 1/14 is 0.0714; their sum is 0.1484, not 0.1483. The page shows what the API sent and what each
// rank adds, each to four places, and says so, instead of nudging a digit to make the column add up.
const RULE = `Each retriever adds 1 / (${RRF_K} + rank). The sum is the score, and the scores decide the fused order. Each figure is rounded to four places, so the last digit of a sum can differ from that of its parts.`
</script>

<template>
  <section class="worked" aria-labelledby="worked-title">
    <h2 id="worked-title">How this passage was ranked</h2>
    <div class="about">
      <h3>{{ hit.title }}</h3>
      <p v-if="source !== ''" class="source">
        {{ source }}<template v-if="hit.ordinal > 0">, passage {{ hit.ordinal + 1 }}</template>
      </p>
      <SnippetText :snippet="hit.snippet" />
    </div>

    <table v-if="position !== null">
      <caption>
        {{
          RULE
        }}
      </caption>
      <thead>
        <tr>
          <th scope="col">Retriever</th>
          <th scope="col">Rank</th>
          <th scope="col">Adds</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="term in terms" :key="term.retriever" :class="term.retriever">
          <th scope="row">{{ term.label }}</th>
          <td v-if="term.rank !== null">{{ term.rank }}</td>
          <td v-else class="words">not in its top {{ CANDIDATES }}</td>
          <td v-if="term.rank !== null">1 / ({{ RRF_K }} + {{ term.rank }}) = {{ term.adds.toFixed(4) }}</td>
          <td v-else>0</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Fused</th>
          <td>{{ position }}</td>
          <td>{{ hit.score.toFixed(4) }}</td>
        </tr>
      </tfoot>
    </table>
    <p v-else class="outside">
      <template v-for="term in terms" :key="term.retriever">
        <template v-if="term.rank !== null">{{ term.label }} rank {{ term.rank }}. </template>
      </template>
      Not in the fused top ten: other passages collected a larger sum from the two lists.
    </p>
  </section>
</template>

<style scoped>
.worked {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1rem 3rem;
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--ink);
}

h2 {
  grid-column: 1 / -1;
  font-size: 1rem;
}

.about {
  display: grid;
  gap: 0.25rem;
  align-content: start;
}

h3 {
  font-size: 1.0625rem;
  line-height: 1.35;
}

.source {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--ink-soft);
  overflow-wrap: anywhere;
}

table {
  align-self: start;
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9375rem;
}

caption {
  padding-bottom: 0.5rem;
  text-align: left;
  font-size: 0.875rem;
  color: var(--ink-soft);
}

th,
td {
  padding: 0.375rem 0.75rem 0.375rem 0;
  border-bottom: 1px solid var(--rule);
  text-align: left;
  font-weight: 400;
}

thead th {
  font-size: 0.8125rem;
  color: var(--ink-soft);
}

tbody th {
  color: var(--retriever);
  font-weight: 600;
}

td {
  font-family: var(--font-mono);
}

td.words {
  font-family: var(--font-ui);
  color: var(--ink-soft);
}

tfoot th,
tfoot td {
  border-bottom: 0;
  border-top: 1px solid var(--ink);
  font-weight: 700;
}

.outside {
  align-self: start;
}

@media (max-width: 48rem) {
  .worked {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
