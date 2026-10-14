<script setup lang="ts">
// One passage in one of the three lists. Pointing at it or tabbing to it shows its path for as long as that lasts;
// clicking or pressing Enter keeps it. What is drawn inside is numbers and a name cut to one line, so the row is named
// for a screen reader in one phrase (`label`), not by whatever its pieces happen to read as in a row.
defineProps<{ on: boolean; pinned: boolean; label: string }>()
const emit = defineEmits<{ pin: []; point: [here: boolean] }>()
</script>

<template>
  <button
    type="button"
    :class="['row', { on }]"
    :aria-label="label"
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
