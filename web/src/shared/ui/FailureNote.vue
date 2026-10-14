<script setup lang="ts">
import { computed } from 'vue'

import { ApiFailure } from '@/shared/api/fathom'

const props = defineProps<{ failure: Error }>()
const emit = defineEmits<{ retry: [] }>()

// What happened, then what to do. The server's own title and detail are shown as they came (problem+json).
const words = computed((): { heading: string; body: string } => {
  const failure = props.failure
  if (!(failure instanceof ApiFailure)) return { heading: 'The search stopped', body: failure.message }
  switch (failure.kind) {
    case 'network':
      return {
        heading: 'No answer from the server',
        body: 'The request did not get through. Check the connection, then search again.',
      }
    case 'rate-limited':
      return {
        heading: 'Too many searches',
        body: 'This address sent more searches than the proxy allows in a second. Wait a few seconds, then search again.',
      }
    case 'server':
      return {
        heading: `The search service answered ${failure.status ?? ''}: ${failure.title}`,
        body: `${failure.detail === '' ? 'It gave no detail.' : sentence(failure.detail)} Search again in a moment.`,
      }
    case 'refused':
      return {
        heading: `The server refused the search (${failure.status ?? ''} ${failure.title})`,
        body: failure.detail === '' ? 'It gave no detail.' : sentence(failure.detail),
      }
    case 'contract':
      return {
        heading: 'The answer is not in the shape this page expects',
        body: 'The page and the API are probably different versions. Reload the page.',
      }
  }
})

function sentence(text: string): string {
  const first = text.charAt(0).toUpperCase() + text.slice(1)
  return /[.!?]$/.test(first) ? first : `${first}.`
}
</script>

<template>
  <div class="failure" role="alert">
    <h2>{{ words.heading }}</h2>
    <p>{{ words.body }}</p>
    <button type="button" @click="emit('retry')">Search again</button>
  </div>
</template>

<style scoped>
.failure {
  display: grid;
  justify-items: start;
  gap: 0.5rem;
  padding: 1rem 1.25rem;
  border: 1px solid var(--alarm);
  border-left-width: 4px;
}

h2 {
  font-size: 1.0625rem;
  color: var(--alarm);
}

button {
  margin-top: 0.25rem;
  padding: 0.5rem 1rem;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--ink);
  color: var(--paper);
  cursor: pointer;
}

button:hover {
  background: var(--paper);
  color: var(--ink);
}
</style>
