<script setup lang="ts">
import { computed } from 'vue'

import { parts } from '@/shared/snippet'

const props = defineProps<{ snippet: string }>()

const pieces = computed(() => parts(props.snippet))
</script>

<template>
  <!-- Interpolation only: each piece becomes a text node, so markup inside a document is shown, not run. -->
  <p class="snippet">
    <template v-for="(piece, index) in pieces" :key="index">
      <mark v-if="piece.match">{{ piece.text }}</mark>
      <template v-else>{{ piece.text }}</template>
    </template>
  </p>
</template>

<style scoped>
.snippet {
  overflow-wrap: anywhere;
}
</style>
