import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// `npm run dev` and `npm run preview` send /api to the compose stack. By default that is the web container, whose
// nginx holds the read key (nginx.conf), so no key is needed here. To run against the API directly, without the web
// container, set FATHOM_API=http://127.0.0.1:8300 and FATHOM_READ_KEY to a key made with `fathom keys create`; the
// key stays in this process and is never sent to the browser.
const direct = process.env.FATHOM_API
const key = process.env.FATHOM_READ_KEY

export default defineConfig({
  plugins: [vue()],
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
      // What the suite holds today, rounded down (99.1, 92.98, 100, 100; the same under Node 24 on Linux and Node 26
      // on Windows). A drop below it is a change someone should look at.
      thresholds: { statements: 99, branches: 92, functions: 100, lines: 100 },
    },
  },
})
