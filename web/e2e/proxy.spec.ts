// What the proxy in front of the API forwards and what it refuses, asked directly, with no page and no key (ADR 8).
// The proxy adds the only key there is, so everything it lets through is open to anyone who can reach this port:
// these tests are the proof that it lets through two routes of one collection and nothing else.

import { expect, test, type APIResponse } from '@playwright/test'

const DEMO = '/api/v1/collections/demo'
const BOGUS_KEY = `fth_${'0'.repeat(16)}_${'a'.repeat(43)}`
const REFUSAL = {
  type: 'about:blank',
  title: 'Not found',
  status: 404,
  detail: 'this origin serves search and stats for one collection',
}
const LIMITED = {
  type: 'about:blank',
  title: 'Too many requests',
  status: 429,
  detail: 'this address is sending requests faster than the proxy allows',
}
const YEAR = 'max-age=31536000'

/**
 * The headers every answer from this origin carries, whichever location in nginx.conf produced it. A location with
 * an `add_header` of its own does not inherit the server's, which is how an error page loses its policy.
 */
function expectSecurityHeaders(response: APIResponse, what: string): void {
  const headers = response.headers()
  expect(headers['content-security-policy'], what).toContain("default-src 'self'")
  expect(headers['content-security-policy'], what).toContain("frame-ancestors 'none'")
  expect(headers['referrer-policy'], what).toBe('no-referrer')
  expect(headers['x-content-type-options'], what).toBe('nosniff')
}

test('the proxy answers the two routes the page uses, without a key from the caller', async ({ request }) => {
  const stats = await request.get(`${DEMO}/stats`)
  expect(stats.status()).toBe(200)
  expect(await stats.json()).toMatchObject({ pending: 0 })

  const search = await request.post(`${DEMO}/search`, { data: { query: 'rank fusion', mode: 'lexical', k: 3 } })
  expect(search.status()).toBe(200)
  expect(await search.json()).toMatchObject({ mode: 'lexical', took_ms: expect.any(Number) })
  expect(Object.keys(search.headers())).not.toContain('authorization')
  expectSecurityHeaders(stats, 'stats')
  expectSecurityHeaders(search, 'search')
})

test('the page and its files carry the security headers, and only what is there is cached for a year', async ({
  request,
}) => {
  const page = await request.get('/compare?q=anything')
  expect(page.status()).toBe(200)
  expectSecurityHeaders(page, 'the page')
  expect(page.headers()['cache-control']).toBe('no-cache')

  // A file the build produced: its name is a hash of its content, so it may be kept for as long as anyone likes.
  const script = /\/assets\/index-[\w-]+\.js/.exec(await page.text())?.[0] ?? ''
  const built = await request.get(script)
  expect(built.status(), script).toBe(200)
  expectSecurityHeaders(built, script)
  expect(built.headers()['cache-control']).toBe(`public, ${YEAR}, immutable`)

  // A name no build produced: the 404 must not be kept for a year, by a browser or by anything in between, or a
  // file that appears later under that name would stay missing.
  const missing = await request.get('/assets/nope.js')
  expect(missing.status()).toBe(404)
  expectSecurityHeaders(missing, '/assets/nope.js')
  expect(missing.headers()['cache-control'] ?? '').not.toContain(YEAR)
  expect(missing.headers()['cache-control'] ?? '').not.toContain('immutable')
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
    expectSecurityHeaders(response, `${method} ${path}`)
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
      expectSecurityHeaders(response, path)
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
  expectSecurityHeaders(response, 'the 413')
})

test('the proxy limits how fast one address may ask for the counts', async ({ request }) => {
  // Ten a second with a burst of thirty, in a bucket apart from the searches. The page asks once per load.
  const answers = await Promise.all(Array.from({ length: 120 }, () => request.get(`${DEMO}/stats`)))
  const limited = answers.filter((answer) => answer.status() === 429)

  expect(new Set(answers.map((answer) => answer.status()))).toEqual(new Set([200, 429]))
  expect(answers.length - limited.length).toBeGreaterThanOrEqual(30)
  expect(limited.length).toBeGreaterThanOrEqual(60)
  // The same refusal as for a search, in words that are true of both limits.
  expect(await limited[0]?.json()).toEqual(LIMITED)
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
  expect(await refusal?.json()).toEqual(LIMITED)
  for (const answer of limited) expectSecurityHeaders(answer, 'a 429')

  // And it lets go again: after the burst has refilled, a search goes through.
  await expect(async () => {
    const response = await request.post(`${DEMO}/search`, { data: { query: 'lease', mode: 'lexical', k: 1 } })
    expect(response.status()).toBe(200)
  }).toPass({ timeout: 10_000 })
})
