import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import type { HtmlTagDescriptor, Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// `npm run dev` and `npm run preview` send /api to the compose stack. By default that is the web container, whose
// nginx holds the read key (nginx.conf), so no key is needed here. To run against the API directly, without the web
// container, set FATHOM_API=http://127.0.0.1:8300 and FATHOM_READ_KEY to a key made with `fathom keys create`; the
// key stays in this process and is never sent to the browser.
const direct = process.env.FATHOM_API
const key = process.env.FATHOM_READ_KEY

/**
 * Every route is loaded on demand, so the browser learns which scripts the search view needs only after the entry
 * script has run: one more round trip before the first thing a person came for is drawn. The search view is where a
 * visit starts, so its scripts are named in the HTML and fetched alongside the entry. They stay separate files, out
 * of the entry chunk, and the comparison view is still fetched only when it is opened.
 */
function preloadFirstRoute(view: string): Plugin {
  return {
    name: 'preload-first-route',
    transformIndexHtml: {
      order: 'post',
      handler(html, context): HtmlTagDescriptor[] {
        const chunks = Object.values(context.bundle ?? {}).filter((file) => file.type === 'chunk')
        const first = chunks.find((chunk) => chunk.facadeModuleId?.endsWith(view) === true)
        if (first === undefined) return []
        return [first.fileName, ...first.imports]
          .filter((file) => !html.includes(file))
          .map((file) => ({
            tag: 'link',
            attrs: { rel: 'modulepreload', crossorigin: true, href: `/${file}` },
            injectTo: 'head',
          }))
      },
    },
  }
}

export default defineConfig({
  plugins: [vue(), preloadFirstRoute('/features/search/SearchView.vue')],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: {
      '/api':
        direct === undefined
          ? { target: 'http://127.0.0.1:8340' }
          : {
              target: direct,
              rewrite: (path: string) => path.slice('/api'.length),
              headers: key === undefined ? {} : { Authorization: `Bearer ${key}` },
            },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,vue}'],
      // The composition root is exercised by the Playwright journeys against the real stack.
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/main.ts', 'src/App.vue', 'src/test/**'],
      reporter: ['text-summary', 'html'],
      // What the suite holds today, rounded down (98.94, 93.44, 100, 100). The statements it does not reach are the
      // branches of the status lines that no state leads to. A drop below this is a change someone should look at.
      thresholds: { statements: 98, branches: 93, functions: 100, lines: 100 },
    },
  },
})
