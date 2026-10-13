<script setup lang="ts">
import { EXAMPLES } from '@/shared/examples'

const emit = defineEmits<{ pick: [query: string] }>()
</script>

<template>
  <section class="examples" aria-labelledby="examples-title">
    <h2 id="examples-title">Queries where the two retrievers disagree</h2>
    <ul>
      <li v-for="example in EXAMPLES" :key="example.query">
        <button type="button" @click="emit('pick', example.query)">{{ example.query }}</button>
        <p>{{ example.shows }}</p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
h2 {
  font-size: 1rem;
  margin-bottom: 0.5rem;
}

ul {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.75rem 1.5rem;
}

li {
  display: grid;
  align-content: start;
  justify-items: start;
  gap: 0.25rem;
}

button {
  padding: 0.375rem 0.625rem;
  border: 1px solid var(--rule-strong);
  border-radius: 0;
  background: var(--band);
  font-family: var(--font-mono);
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
}

button:hover {
  border-color: var(--ink);
  background: var(--paper);
}

p {
  font-size: 0.875rem;
  color: var(--ink-soft);
}
</style>
