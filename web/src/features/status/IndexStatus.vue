<script setup lang="ts">
import { computed } from 'vue'

import { useStats } from '@/shared/api/queries'

const { data, isError } = useStats()

// fathom stores a document before its vectors exist (ADR 5). While chunks are waiting, text search already finds
// them and vector search does not, which is worth saying next to results that might look incomplete.
const line = computed(() => {
  if (isError.value) return 'Index status is unavailable.'
  const stats = data.value
  if (stats === undefined) return 'Reading the index.'
  const size = `${stats.documents} documents in ${stats.chunks} chunks`
  if (stats.pending === 0) return `${size}, all with vectors.`
  return `${size}; ${stats.pending} still waiting for a vector and found by text only.`
})
</script>

<template>
  <p role="status" :class="{ waiting: (data?.pending ?? 0) > 0 }">{{ line }}</p>
</template>

<style scoped>
.waiting {
  color: var(--ink);
  font-weight: 600;
}
</style>
