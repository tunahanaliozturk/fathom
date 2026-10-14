<script setup lang="ts">
import type { Mode } from '@/shared/api/modes'

defineProps<{ mode: Mode }>()
const emit = defineEmits<{ pick: [mode: Mode] }>()

const OPTIONS: { mode: Mode; label: string; means: string }[] = [
  { mode: 'hybrid', label: 'Hybrid', means: 'both, fused by rank' },
  { mode: 'lexical', label: 'Lexical', means: 'shared words' },
  { mode: 'vector', label: 'Vector', means: 'nearest meaning' },
]
</script>

<template>
  <fieldset class="modes">
    <legend>Retriever</legend>
    <label v-for="option in OPTIONS" :key="option.mode" :class="['option', option.mode]">
      <input
        type="radio"
        name="mode"
        :value="option.mode"
        :checked="option.mode === mode"
        @change="emit('pick', option.mode)"
      />
      <span class="face">
        <span class="label">{{ option.label }}</span>
        <span class="means">{{ option.means }}</span>
      </span>
    </label>
  </fieldset>
</template>

<style scoped>
.modes {
  /* Ink for hybrid; the lexical and vector options take their own colour from tokens.css. */
  --retriever: var(--ink);
  display: flex;
  flex-wrap: wrap;
  margin: 0;
  padding: 0;
  border: 0;
}

legend {
  padding: 0 0 0.375rem;
  font-weight: 600;
}

.option {
  position: relative;
  margin-right: -1px;
  cursor: pointer;
}

/* The radio itself stays in the page for the keyboard and for screen readers; its face is what is drawn. */
input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.face {
  display: grid;
  padding: 0.5rem 1rem 0.5rem 0.875rem;
  border: 1px solid var(--rule-strong);
  border-left: 4px solid var(--rule);
}

.label {
  font-weight: 600;
}

.means {
  font-size: 0.8125rem;
  color: var(--ink-soft);
}

input:checked + .face {
  border-color: var(--ink);
  border-left-color: var(--retriever);
  background: var(--band);
}

input:focus-visible + .face {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
  position: relative;
  z-index: 1;
}
</style>
