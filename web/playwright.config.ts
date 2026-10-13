import { defineConfig, devices } from '@playwright/test'

const ci = process.env.CI !== undefined

/** The journeys run against the compose stack: nginx, the API, the indexer, Postgres and the seeded corpus. */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.FATHOM_WEB_URL ?? 'http://127.0.0.1:8340',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testMatch: 'journeys.spec.ts', use: devices['Desktop Chrome'] },
    // One Firefox window at a time: headless Firefox only treats one window as active, so keyboard and focus
    // assertions fail at random when several run side by side. A person has one window in front. The browser
    // journeys live in one file so that this setting is enough.
    { name: 'firefox', testMatch: 'journeys.spec.ts', use: devices['Desktop Firefox'], fullyParallel: false },
    // No browser: what the proxy refuses, asked directly. It runs last because its final test drains the rate
    // limiter on purpose, and every client of the local stack shares one address behind Docker's port forward.
    { name: 'proxy', testMatch: 'proxy.spec.ts', fullyParallel: false, dependencies: ['chromium', 'firefox'] },
  ],
})
