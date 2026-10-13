<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

// The status line needs the parser and the query cache. Loading it apart from the shell keeps both out of the entry
// chunk; the space it will fill is reserved in the header, so nothing moves when it arrives.
const IndexStatus = defineAsyncComponent(() => import('@/features/status/IndexStatus.vue'))

const route = useRoute()
// Moving between the two views keeps the query: the same question, looked at another way.
const carried = computed(() => (typeof route.query.q === 'string' && route.query.q !== '' ? { q: route.query.q } : {}))
</script>

<template>
  <a class="skip" href="#main">Skip to the query</a>
  <header class="top">
    <div class="bar">
      <p class="name">fathom <span>console</span></p>
      <nav aria-label="Views">
        <RouterLink :to="{ name: 'search', query: carried }">Search</RouterLink>
        <RouterLink :to="{ name: 'compare', query: carried }">Compare</RouterLink>
      </nav>
      <div class="status"><IndexStatus /></div>
    </div>
  </header>
  <main id="main" tabindex="-1">
    <RouterView />
  </main>
  <footer class="foot">
    <p>
      The corpus is fathom's own documentation and a glossary of search terms, one document per section. A rank is a
      passage's place among the 50 candidates a retriever returns.
    </p>
  </footer>
</template>

<style scoped>
.skip {
  position: absolute;
  left: var(--gutter);
  top: -4rem;
  z-index: 1;
  padding: 0.5rem 0.75rem;
  background: var(--ink);
  color: var(--paper);
}

.skip:focus {
  top: 0.5rem;
}

.top {
  border-bottom: 1px solid var(--ink);
}

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 2rem;
  max-width: var(--page);
  margin: 0 auto;
  padding: 0.75rem var(--gutter) 0;
}

.name {
  font-family: var(--font-mono);
  font-size: 1.0625rem;
  font-weight: 700;
  padding-bottom: 0.75rem;
}

.name span {
  font-weight: 400;
  color: var(--ink-soft);
}

nav {
  display: flex;
  gap: 1.5rem;
}

nav a {
  padding-bottom: 0.625rem;
  border-bottom: 3px solid transparent;
  color: var(--ink-soft);
  text-decoration: none;
}

nav a:hover {
  color: var(--ink);
}

nav a[aria-current='page'] {
  border-bottom-color: var(--ink);
  color: var(--ink);
  font-weight: 600;
}

/* The line is filled in after the shell is drawn and its text changes length. A box of fixed width with the text
   set to its right edge means that neither moves anything else. */
.status {
  flex: 0 1 30rem;
  margin-left: auto;
  min-height: 2.0625rem;
  padding-bottom: 0.75rem;
  font-size: 0.875rem;
  text-align: right;
  color: var(--ink-soft);
}

/* A screen tall at least: the view arrives a moment after the shell, and the footer must not be on screen to be
   pushed down when it does. */
main {
  max-width: var(--page);
  min-height: 100vh;
  margin: 0 auto;
  padding: 2rem var(--gutter) 4rem;
}

main:focus {
  outline: none;
}

.foot {
  border-top: 1px solid var(--rule);
}

.foot p {
  max-width: var(--page);
  margin: 0 auto;
  padding: 1rem var(--gutter) 2rem;
  font-size: 0.875rem;
  color: var(--ink-soft);
}

@media (max-width: 56rem) {
  .status {
    flex-basis: 100%;
    margin-left: 0;
    text-align: left;
  }
}
</style>
