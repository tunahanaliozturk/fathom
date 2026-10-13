<script setup lang="ts">
import { computed } from 'vue'

import type { Hit } from '@/shared/api/fathom'
import type { Mode } from '@/shared/api/modes'
import { sourceOf } from '@/shared/ranking'
import SnippetText from '@/shared/ui/SnippetText.vue'

import RankReadout from './RankReadout.vue'

const props = defineProps<{ hit: Hit; position: number; mode: Mode }>()

const source = computed(() => sourceOf(props.hit))
</script>

<template>
  <li class="result">
    <p class="position"><span class="unseen">Result </span>{{ position }}</p>
    <div class="body">
      <h2>{{ hit.title }}</h2>
      <p v-if="source !== ''" class="source">
        {{ source }}<template v-if="hit.ordinal > 0">, passage {{ hit.ordinal + 1 }}</template>
      </p>
      <SnippetText :snippet="hit.snippet" />
    </div>
    <RankReadout :hit="hit" :mode="mode" />
  </li>
</template>

<style scoped>
.result {
  display: grid;
  grid-template-columns: 2.5rem minmax(0, 1fr) 15rem;
  column-gap: 1rem;
  padding: 1rem 0;
  border-top: 1px solid var(--rule);
}

.position {
  font-family: var(--font-mono);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.3;
  text-align: right;
}

.body {
  display: grid;
  gap: 0.25rem;
  align-content: start;
}

h2 {
  font-size: 1.0625rem;
  line-height: 1.35;
}

.source {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--ink-soft);
  overflow-wrap: anywhere;
}

@media (max-width: 48rem) {
  .result {
    grid-template-columns: 2.5rem minmax(0, 1fr);
    row-gap: 0.75rem;
  }

  .readout {
    grid-column: 2;
    max-width: 18rem;
  }
}
</style>
