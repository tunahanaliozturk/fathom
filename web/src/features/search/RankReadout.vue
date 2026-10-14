<script setup lang="ts">
import { computed } from 'vue'

import type { Hit } from '@/shared/api/fathom'
import { RETRIEVERS, type Mode, type Retriever } from '@/shared/api/modes'
import { CANDIDATES, rankIn } from '@/shared/ranking'

const props = defineProps<{ hit: Hit; mode: Mode }>()

const LABEL: Record<Retriever, string> = { lexical: 'Lexical', vector: 'Vector' }

const rows = computed(() =>
  RETRIEVERS.map((retriever) => {
    const rank = rankIn(props.hit, retriever)
    const ran = props.mode === 'hybrid' || props.mode === retriever
    return {
      retriever,
      label: LABEL[retriever],
      rank,
      absent: ran ? `not in its top ${CANDIDATES}` : 'not run',
      // Where the rank falls between first and last candidate, as a position along the track.
      x: rank === null ? 0 : 1 + (Math.min(rank, CANDIDATES) - 1) * (98 / (CANDIDATES - 1)),
    }
  }),
)
</script>

<template>
  <dl class="readout">
    <div v-for="row in rows" :key="row.retriever" :class="['line', row.retriever]">
      <dt>{{ row.label }}</dt>
      <dd>
        <template v-if="row.rank !== null">
          <span class="unseen">rank </span><span class="rank">{{ row.rank }}</span>
        </template>
        <span v-else class="absent">{{ row.absent }}</span>
        <!-- First candidate at the left end, fiftieth at the right. Decoration: the number beside it says the same. -->
        <svg class="track" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <line class="rail" x1="0" y1="4" x2="100" y2="4" />
          <line v-if="row.rank !== null" class="tick" :x1="row.x" y1="0" :x2="row.x" y2="8" />
        </svg>
      </dd>
    </div>
    <div class="line score">
      <dt>Score</dt>
      <dd>{{ hit.score.toFixed(4) }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.readout {
  display: grid;
  align-content: start;
  gap: 0.25rem;
  font-size: 0.875rem;
}

.line {
  display: grid;
  grid-template-columns: 4rem 1fr;
  align-items: center;
  column-gap: 0.5rem;
}

dt {
  color: var(--retriever, var(--ink-soft));
  font-weight: 600;
}

dd {
  display: grid;
  grid-template-columns: 2rem 1fr;
  align-items: center;
  column-gap: 0.5rem;
  font-family: var(--font-mono);
}

.rank {
  text-align: right;
  font-weight: 700;
  color: var(--retriever);
}

.absent {
  grid-column: 1 / -1;
  font-family: var(--font-ui);
  color: var(--ink-soft);
}

.absent + .track {
  display: none;
}

.track {
  width: 100%;
  height: 0.5rem;
}

.rail {
  stroke: var(--rule);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.tick {
  stroke: var(--retriever);
  stroke-width: 3;
  vector-effect: non-scaling-stroke;
}

.score dd {
  display: block;
}
</style>
