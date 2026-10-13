// What the proxy in front of the API forwards and what it refuses, asked directly, with no page and no key (ADR 8).
// The proxy adds the only key there is, so everything it lets through is open to anyone who can reach this port:
// these tests are the proof that it lets through two routes of one collection and nothing else.

import { expect, test } from '@playwright/test'

const DEMO = '/api/v1/collections/demo'
const BOGUS_KEY = `fth_${'0'.repeat(16)}_${'a'.repeat(43)}`
const REFUSAL = {
  type: 'about:blank',
  title: 'Not found',
  status: 404,
  detail: 'this origin serves search and stats for one collection',
}

test('the proxy answers the two routes the page uses, without a key from the caller', async ({ request }) => {
  const stats = await request.get(`${DEMO}/stats`)
  expect(stats.status()).toBe(200)
  expect(await stats.json()).toMatchObject({ pending: 0 })

  const search = await request.post(`${DEMO}/search`, { data: { query: 'rank fusion', mode: 'lexical', k: 3 } })
  expect(search.status()).toBe(200)
  expect(await search.json()).toMatchObject({ mode: 'lexical', took_ms: expect.any(Number) })
  expect(Object.keys(search.headers())).not.toContain('authorization')
})

test('the proxy refuses every other route under the API prefix', async ({ request }) => {
  const refused: [method: string, path: string][] = [
    // The two paths it knows, with a method it does not forward.
    ['GET', `${DEMO}/search`],
    ['PUT', `${DEMO}/search`],
    ['DELETE', `${DEMO}/search`],
    ['POST', `${DEMO}/stats`],
    ['DELETE', `${DEMO}/stats`],
    // Writing, reading and deleting documents: the API has these routes, the key could not use them, and the proxy
    // does not even ask.
    ['POST', `${DEMO}/documents`],
    ['GET', `${DEMO}/documents/readme`],
    ['PUT', `${DEMO}/documents/readme`],
    ['DELETE', `${DEMO}/documents/readme`],
    // Close to an allowed path, and not it.
    ['POST', `${DEMO}/search/`],
    ['POST', `${DEMO}/search/extra`],
    ['POST', `${DEMO}/searching`],
    ['GET', `${DEMO}/stats/`],
    ['GET', DEMO],
    // The rest of what the API serves.
    ['GET', '/api/openapi.json'],
    ['GET', '/api/docs'],
    ['GET', '/api/healthz'],
    ['GET', '/api/readyz'],
    ['GET', '/api/'],
  ]

  for (const [method, path] of refused) {
    const response = await request.fetch(path, { method, data: method === 'GET' ? undefined : { query: 'x' } })
    expect(response.status(), `${method} ${path}`).toBe(404)
    expect(response.headers()['content-type'], `${method} ${path}`).toBe('application/problem+json')
    // nginx's own answer, word for word: the request did not reach the API.
    expect(await response.json(), `${method} ${path}`).toEqual(REFUSAL)
  }
})

test('the proxy refuses a search in another collection', async ({ request }) => {
  // `smoke` exists on a stack that has run the quick start; the others are names someone might try.
  for (const collection of ['smoke', 'eval-ci', 'other', 'demo2', 'Demo', '%2A', 'demo%2F..%2Fsmoke']) {
    for (const route of ['search', 'stats']) {
      const path = `/api/v1/collections/${collection}/${route}`
      const response = await request.fetch(path, {
        method: route === 'search' ? 'POST' : 'GET',
        data: route === 'search' ? { query: 'tower' } : undefined,
      })
      expect(response.status(), path).toBe(404)
      expect(await response.json(), path).toEqual(REFUSAL)
    }
  }
})

test('the proxy replaces an Authorization header instead of forwarding it', async ({ request }) => {
  // Forwarded as sent, this key would get a 401 from the API. The proxy overwrites it with its own.
  const response = await request.post(`${DEMO}/search`, {
    headers: { Authorization: `Bearer ${BOGUS_KEY}` },
    data: { query: 'rank fusion', mode: 'lexical', k: 1 },
  })

  expect(response.status()).toBe(200)
})

test('the proxy refuses a body larger than a search needs', async ({ request }) => {
  const response = await request.post(`${DEMO}/search`, { data: { query: 'x', filter: { pad: 'x'.repeat(16_000) } } })

  expect(response.status()).toBe(413)
})

test('the proxy limits how fast one address may search', async ({ request }) => {
  // Ten a second with a burst of thirty: of a hundred and twenty at once, most are turned away. This empties the
  // bucket for every client of the stack behind the same address, which is why the test is the last to run.
  const answers = await Promise.all(
    Array.from({ length: 120 }, () =>
      request.post(`${DEMO}/search`, { data: { query: 'lease', mode: 'lexical', k: 1 } }),
    ),
  )
  const statuses = answers.map((answer) => answer.status())
  const limited = answers.filter((answer) => answer.status() === 429)

  expect(new Set(statuses)).toEqual(new Set([200, 429]))
  expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(30)
  expect(limited.length).toBeGreaterThanOrEqual(60)
  const refusal = limited[0]
  expect(refusal?.headers()['content-type']).toBe('application/problem+json')
  expect(refusal?.headers()['retry-after']).toBe('1')
  expect(await refusal?.json()).toEqual({
    type: 'about:blank',
    title: 'Too many requests',
    status: 429,
    detail: 'one address may send 10 searches a second',
  })

  // And it lets go again: after the burst has refilled, a search goes through.
  await expect(async () => {
    const response = await request.post(`${DEMO}/search`, { data: { query: 'lease', mode: 'lexical', k: 1 } })
    expect(response.status()).toBe(200)
  }).toPass({ timeout: 10_000 })
})
