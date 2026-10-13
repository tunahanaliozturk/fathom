<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { SHOWN, type Hit } from '@/shared/api/fathom'
import { RETRIEVERS, type Retriever } from '@/shared/api/modes'
import { CANDIDATES, labelOf, passageOf, rankIn, RRF_K } from '@/shared/ranking'

import { curve, links, ROW, WIDTH } from './flow'
import FlowRow from './FlowRow.vue'
import WorkedScore from './WorkedScore.vue'

const props = defineProps<{ lexical: Hit[]; fused: Hit[]; vector: Hit[] }>()

// The passage whose path is drawn in full. A click or Enter pins one; pointing at or tabbing to another shows that
// one for as long as the pointer or the focus stays.
const first = (hits: Hit[]): string | null => (hits[0] === undefined ? null : passageOf(hits[0]))
const pinned = ref(first(props.fused))
const pointed = ref<string | null>(null)
const active = computed(() => pointed.value ?? pinned.value)

watch(
  () => props.fused,
  (fused) => {
    pinned.value = first(fused)
    pointed.value = null
  },
)

function point(passage: string, here: boolean): void {
  if (here) pointed.value = passage
  else if (pointed.value === passage) pointed.value = null
}

const sides = computed(() => ({
  lexical: links('lexical', props.lexical, props.fused),
  vector: links('vector', props.vector, props.fused),
}))

// In reading order, which is also the order across the screen: a retriever, the fused list, the other retriever.
const columns = computed(() => [
  { name: 'lexical' as const, title: 'Lexical', means: 'words in common, ts_rank', hits: props.lexical },
  { name: 'fused' as const, title: 'Fused', means: `reciprocal rank fusion, k = ${RRF_K}`, hits: props.fused },
  { name: 'vector' as const, title: 'Vector', means: 'nearest meaning, HNSW', hits: props.vector },
])

const EMPTY: Record<Retriever, string> = {
  lexical: 'No passage shares a word with this query.',
  vector: 'No passage has a vector yet.',
}

const hasLane = (retriever: Retriever): boolean => sides.value[retriever].some((link) => link.from === SHOWN)

/** What is known about the pinned passage: its fused place if it has one, and its rank in each retriever. */
const worked = computed(() => {
  const passage = pinned.value
  const same = (hit: Hit): boolean => passageOf(hit) === passage
  const place = props.fused.findIndex(same)
  const fused = props.fused[place]
  if (fused !== undefined) {
    return { hit: fused, position: place + 1, lexical: rankIn(fused, 'lexical'), vector: rankIn(fused, 'vector') }
  }
  const lexical = props.lexical.find(same)
  const vector = props.vector.find(same)
  const hit = lexical ?? vector
  if (hit === undefined) return null
  return {
    hit,
    position: null,
    lexical: lexical === undefined ? null : rankIn(lexical, 'lexical'),
    vector: vector === undefined ? null : rankIn(vector, 'vector'),
  }
})

const HEIGHT = (SHOWN + 1) * ROW
</script>

<template>
  <div class="flow">
    <template v-for="column in columns" :key="column.name">
      <!-- The lines repeat what the numbers in the fused rows say, so the drawings are hidden from screen readers. -->
      <svg
        v-if="column.name === 'vector'"
        class="links vector"
        :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          v-for="link in sides.vector"
          :key="link.passage"
          :class="{ on: active === link.passage, far: link.from === SHOWN }"
          :d="curve(link, 'right')"
        />
      </svg>

      <section :class="['column', column.name]" :aria-labelledby="`flow-${column.name}`">
        <header>
          <h2 :id="`flow-${column.name}`">{{ column.title }}</h2>
          <p>{{ column.means }}</p>
        </header>
        <div class="rows">
          <ol v-if="column.hits.length > 0">
            <li v-for="(hit, index) in column.hits" :key="passageOf(hit)">
              <FlowRow
                :on="active === passageOf(hit)"
                :pinned="pinned === passageOf(hit)"
                @pin="pinned = passageOf(hit)"
                @point="(here) => point(passageOf(hit), here)"
              >
                <template v-if="column.name === 'fused'">
                  <span v-for="retriever in RETRIEVERS" :key="retriever" :class="['came', retriever]">
                    <template v-if="rankIn(hit, retriever) !== null">
                      <span class="unseen">{{ retriever }} rank </span>{{ rankIn(hit, retriever) }}
                    </template>
                    <template v-else>
                      <span class="unseen">not returned by the {{ retriever }} retriever</span>
                      <span aria-hidden="true">none</span>
                    </template>
                    <span class="unseen">, </span>
                  </span>
                  <span class="place"
                    ><span class="unseen">fused rank </span>{{ index + 1 }}<span class="unseen">, </span></span
                  >
                </template>
                <span v-else class="rank">
                  <span class="unseen">{{ column.name }} rank </span>{{ rankIn(hit, column.name)
                  }}<span class="unseen">, </span>
                </span>
                <span class="title">
                  <!-- A long section is several passages, and each retriever may prefer a different one. -->
                  <span class="name">
                    {{ labelOf(hit).name }}<template v-if="hit.ordinal > 0"> (passage {{ hit.ordinal + 1 }})</template>
                  </span>
                  <span v-if="labelOf(hit).within !== ''" class="within">
                    <span class="unseen">, </span>{{ labelOf(hit).within }}
                  </span>
                </span>
              </FlowRow>
            </li>
          </ol>
          <p v-else-if="column.name !== 'fused'" class="none">{{ EMPTY[column.name] }}</p>
          <p v-if="column.name !== 'fused' && hasLane(column.name)" class="lane">
            other passages, down to rank {{ CANDIDATES }}
          </p>
        </div>
      </section>

      <svg
        v-if="column.name === 'lexical'"
        class="links lexical"
        :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          v-for="link in sides.lexical"
          :key="link.passage"
          :class="{ on: active === link.passage, far: link.from === SHOWN }"
          :d="curve(link, 'left')"
        />
      </svg>
    </template>
  </div>

  <WorkedScore
    v-if="worked !== null"
    :hit="worked.hit"
    :position="worked.position"
    :lexical="worked.lexical"
    :vector="worked.vector"
  />
</template>

<style scoped>
/* Five tracks: a retriever's list, the lines out of it, the fused list, the lines into it from the other side, the
   other retriever's list. Every row is the same height everywhere, which is what lets a line drawn in the SVG's own
   units land on the middle of a row. */
.flow {
  --row: 3.5rem;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 4.5rem minmax(0, 1.2fr) 4.5rem minmax(0, 1fr);
  grid-template-rows: auto auto;
}

.column {
  display: grid;
  grid-template-rows: subgrid;
  grid-row: 1 / span 2;
  min-width: 0;
}

.column.lexical {
  grid-column: 1;
}

.column.fused {
  --retriever: var(--ink);
  grid-column: 3;
}

.column.vector {
  grid-column: 5;
}

header {
  padding: 0.5rem 0.75rem 0.625rem;
  border-top: 4px solid var(--retriever);
  border-bottom: 1px solid var(--rule);
}

h2 {
  font-size: 1.0625rem;
  color: var(--retriever);
}

header p {
  font-size: 0.8125rem;
  color: var(--ink-soft);
}

.rows {
  position: relative;
  min-height: calc(11 * var(--row));
}

li {
  height: var(--row);
  border-bottom: 1px solid var(--rule);
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 2.25rem;
  align-items: center;
  column-gap: 0.5rem;
  width: 100%;
  height: 100%;
  padding: 0 0.75rem;
  border: 0;
  border-radius: 0;
  background: none;
  text-align: left;
  cursor: pointer;
}

.row:focus-visible {
  outline-offset: -2px;
}

.title {
  display: grid;
  min-width: 0;
  font-size: 0.875rem;
  line-height: 1.35;
}

/* One line each. The section is what tells two rows of one document apart, so it is the line that is never cut
   short by the other. */
.name,
.within {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.within {
  font-size: 0.8125rem;
  color: var(--ink-soft);
}

.rank,
.came,
.place {
  font-family: var(--font-mono);
  font-weight: 700;
}

.rank,
.came {
  color: var(--retriever);
}

/* The number sits at the edge the lines leave from: right for the lexical list, left for the vector list. */
.lexical .rank {
  grid-column: 2;
  grid-row: 1;
  text-align: right;
}

.lexical .title {
  grid-column: 1;
  grid-row: 1;
}

.vector .row {
  grid-template-columns: 2.25rem minmax(0, 1fr);
}

/* A fused row reads across like the picture: the lexical rank it came from, its fused place, the passage, the vector
   rank it came from. */
.fused .row {
  grid-template-columns: 2.25rem 1.75rem minmax(0, 1fr) 2.25rem;
}

.fused .row > * {
  grid-row: 1;
}

.fused .came.lexical {
  grid-column: 1;
}

.fused .place {
  grid-column: 2;
}

.fused .title {
  grid-column: 3;
}

.fused .came.vector {
  grid-column: 4;
  text-align: right;
}

.fused .came [aria-hidden] {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--ink-soft);
}

.place {
  font-size: 1.125rem;
}

.fused .name {
  font-weight: 600;
}

.row.on {
  background: var(--band);
}

.row[aria-pressed='true'] {
  box-shadow: inset 0 0 0 1px var(--ink);
}

.lexical .row.on {
  background: var(--lexical-wash);
}

.vector .row.on {
  background: var(--vector-wash);
}

.none {
  padding: 1rem 0.75rem;
  font-size: 0.875rem;
  color: var(--ink-soft);
}

.lane {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  align-items: center;
  height: var(--row);
  padding: 0 0.75rem;
  border-top: 1px dashed var(--rule-strong);
  font-size: 0.8125rem;
  color: var(--ink-soft);
}

.lexical .lane {
  justify-content: flex-end;
}

.links {
  grid-row: 2;
  width: 100%;
  height: calc(11 * var(--row));
}

.links.lexical {
  grid-column: 2;
  --retriever: var(--lexical);
}

.links.vector {
  grid-column: 4;
  --retriever: var(--vector);
}

path {
  fill: none;
  stroke: var(--retriever);
  stroke-width: 1.5;
  stroke-opacity: 0.4;
  vector-effect: non-scaling-stroke;
  transition: stroke-opacity 120ms ease-out;
}

path.far {
  stroke-dasharray: 4 3;
}

path.on {
  stroke-width: 3;
  stroke-opacity: 1;
}

/* Too narrow for three lists side by side: stack them. The lines go; the numbers in each fused row carry the same
   information. */
@media (max-width: 60rem) {
  .flow {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: none;
    row-gap: 2rem;
  }

  .column,
  .column.lexical,
  .column.fused,
  .column.vector {
    grid-column: 1;
    grid-row: auto;
    grid-template-rows: none;
  }

  .rows {
    min-height: 0;
  }

  .lane,
  .links {
    display: none;
  }
}
</style>
