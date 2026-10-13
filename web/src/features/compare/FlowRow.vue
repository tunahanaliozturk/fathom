<script setup lang="ts">
// One passage in one of the three lists. Pointing at it or tabbing to it shows its path for as long as that lasts;
// clicking or pressing Enter keeps it.
defineProps<{ on: boolean; pinned: boolean }>()
const emit = defineEmits<{ pin: []; point: [here: boolean] }>()
</script>

<template>
  <button
    type="button"
    :class="['row', { on }]"
    :aria-pressed="pinned"
    @click="emit('pin')"
    @mouseenter="emit('point', true)"
    @mouseleave="emit('point', false)"
    @focus="emit('point', true)"
    @blur="emit('point', false)"
  >
    <slot />
  </button>
</template>
