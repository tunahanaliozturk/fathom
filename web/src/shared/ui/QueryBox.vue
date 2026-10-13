<script setup lang="ts">
import { onScopeDispose, ref, useTemplateRef, watch } from 'vue'

import { QUERY_MAX } from '@/shared/api/modes'

const props = defineProps<{ query: string }>()
const emit = defineEmits<{ search: [query: string] }>()

// Long enough that a word typed at an ordinary speed is one request, short enough that the list still follows the
// typing. The comparison sends three requests per pause, which stays inside the proxy's ten a second (nginx.conf).
const PAUSE = 300

const draft = ref(props.query)
let timer: ReturnType<typeof setTimeout> | undefined

// The address changed without typing here: a link, the back button, an example query.
watch(
  () => props.query,
  (query) => {
    if (query !== draft.value.trim()) draft.value = query
  },
)

function send(): void {
  clearTimeout(timer)
  const query = draft.value.trim()
  if (query !== props.query) emit('search', query)
}

function typed(): void {
  clearTimeout(timer)
  timer = setTimeout(send, PAUSE)
}

onScopeDispose(() => clearTimeout(timer))

// For the view around it: when the control that had focus is removed (an example that was chosen, a "Search again"
// that worked), focus belongs here and not on the page as a whole.
const field = useTemplateRef<HTMLInputElement>('field')
defineExpose({ focus: () => field.value?.focus() })
</script>

<template>
  <form role="search" class="box" @submit.prevent="send">
    <label for="query">Query</label>
    <!-- Leaving the box sends what is in it: a click on the other view within the pause would otherwise lose it. -->
    <input
      id="query"
      ref="field"
      v-model="draft"
      type="search"
      name="q"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      :maxlength="QUERY_MAX"
      aria-describedby="query-hint"
      @input="typed"
      @blur="send"
    />
    <p id="query-hint">Results follow as you type. A question, a phrase or an exact identifier all work.</p>
  </form>
</template>

<style scoped>
.box {
  display: grid;
  gap: 0.375rem;
}

label {
  font-weight: 600;
}

input {
  width: 100%;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--rule-strong);
  border-bottom: 2px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  font-family: var(--font-mono);
  font-size: 1.125rem;
  appearance: none;
}

input:focus-visible {
  outline-offset: 0;
}

p {
  font-size: 0.875rem;
  color: var(--ink-soft);
}
</style>
