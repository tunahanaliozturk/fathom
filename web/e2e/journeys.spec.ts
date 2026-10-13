// The journeys the console exists for, against the real stack: nginx, the API, the embedding model, the indexer,
// Postgres, and the corpus the seed step sent. Nothing here writes, so the tests can run side by side and again.
//
// The titles and ranks asserted below are what this repository's documentation returns (ADR 9). When an edit to the
// documentation moves one, the failure is the reminder to look at the example it belongs to.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page, type Request, type Response } from '@playwright/test'

const PARAPHRASE = 'malicious javascript smuggled into a webpage'
const NUMBER = '0.6003'
const QUESTION = 'what happens if the machine dies halfway through a job'
const AGREED = 'reciprocal rank fusion k'

const SEARCH = '**/api/v1/collections/demo/search'
const API_KEY = /fth_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/

const address = (path: string, query: string, mode?: string): string =>
  `${path}?q=${encodeURIComponent(query)}${mode === undefined ? '' : `&mode=${mode}`}`

const queryBox = (page: Page): Locator => page.getByRole('searchbox', { name: 'Query' })
const results = (page: Page): Locator => page.getByRole('list', { name: 'Results' }).getByRole('listitem')
const outcome = (page: Page): Locator => page.getByRole('main').getByRole('status')
const indexStatus = (page: Page): Locator => page.getByRole('banner').getByRole('status')
const column = (page: Page, name: 'Lexical' | 'Fused' | 'Vector'): Locator =>
  page.getByRole('region', { name, exact: true })
const worked = (page: Page): Locator => page.getByRole('region', { name: 'How this passage was ranked' })

/** A result's readout: where the lexical retriever ranked it, where the vector retriever did, and its score. */
const readout = (result: Locator) => ({
  lexical: result.getByRole('definition').nth(0),
  vector: result.getByRole('definition').nth(1),
  score: result.getByRole('definition').nth(2),
})

/** A row of the comparison by the parts of its accessible name, in order. Spacing between parts is left open. */
const named = (...parts: string[]): RegExp =>
  new RegExp(
    parts
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`).replaceAll(' ', String.raw`\s*`))
      .join(String.raw`\s*,\s*`),
  )

async function axe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([])
}

test('a search runs from the keyboard alone', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible()

  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to the query' })).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(queryBox(page)).toBeFocused()

  await page.keyboard.type(AGREED)
  await expect(results(page).first().getByRole('heading')).toHaveText('Glossary: Reciprocal rank fusion')
  await expect(page).toHaveURL(/\/\?q=reciprocal\+rank\+fusion\+k$/)
  await expect(outcome(page)).toHaveText(/^10 results from hybrid search in [\d.]+ ms\.$/)

  await page.keyboard.press('Tab')
  await expect(page.getByRole('radio', { name: /Hybrid/ })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: /Lexical/ })).toBeChecked()
  await expect(page).toHaveURL(/mode=lexical$/)
  await expect(outcome(page)).toHaveText(/^10 results from lexical search/)

  // On to the other view, still without a mouse: back up to the navigation, then Enter on its link.
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('link', { name: 'Compare' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/compare\?q=reciprocal\+rank\+fusion\+k$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Compare retrievers' })).toBeFocused()
})

test('typing sends one search per pause, not one per key', async ({ page }) => {
  const sent: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/search')) sent.push(request.postData() ?? '')
  })
  await page.goto('/')

  await queryBox(page).pressSequentially('constant time comparison', { delay: 25 })

  await expect(results(page).first().getByRole('heading')).toHaveText('Glossary: Constant-time comparison')
  // 24 keys, 25 ms apart: every gap is shorter than the 300 ms pause, so only the finished query is sent.
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('"query":"constant time comparison"')
})

test('a paraphrase is found by the vector retriever and not by the lexical one', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: PARAPHRASE }).click()
  await expect(queryBox(page)).toHaveValue(PARAPHRASE)

  // Hybrid: the glossary entry is first, on the strength of the vector retriever alone.
  const first = results(page).first()
  await expect(first.getByRole('heading')).toHaveText('Glossary: Cross-site scripting')
  await expect(first).toContainText('corpus/glossary.md')
  await expect(readout(first).lexical).toHaveText('not in its top 50')
  await expect(readout(first).vector).toHaveText(/^rank\s*1$/)
  await expect(readout(first).score).toHaveText('0.0909')

  // Lexical: not one of the query's words is in the corpus.
  await page.getByRole('radio', { name: /Lexical/ }).check()
  await expect(page.getByRole('heading', { name: 'Nothing matched' })).toBeVisible()
  await expect(page.getByText('needs at least one word in common')).toBeVisible()
  await expect(outcome(page)).toHaveText('No results.')

  // Vector: the same entry, and the page says that the lexical retriever was not asked.
  await page.getByRole('radio', { name: /Vector/ }).check()
  await expect(results(page).first().getByRole('heading')).toHaveText('Glossary: Cross-site scripting')
  await expect(readout(results(page).first()).lexical).toHaveText('not run')
})

test('an exact number is found by the lexical retriever, and fusion puts it first', async ({ page }) => {
  await page.goto(address('/', NUMBER))

  const first = results(page).first()
  await expect(first.getByRole('heading')).toHaveText('fathom: Relevance')
  await expect(readout(first).lexical).toHaveText(/^rank\s*1$/)
  // The vector retriever has the passage, a long way down: a number means little to an embedding model.
  const vectorRank = Number((await readout(first).vector.innerText()).replace(/\D/g, ''))
  expect(vectorRank).toBeGreaterThan(10)
  // What fusion did with those two ranks, to four places, is the score the API returned.
  await expect(readout(first).score).toHaveText((1 / 11 + 1 / (10 + vectorRank)).toFixed(4))

  await page.getByRole('radio', { name: /Lexical/ }).check()
  await expect(outcome(page)).toHaveText(/^1 result from lexical search/)
  await expect(results(page)).toHaveCount(1)
})

test('a snippet marks the words that matched', async ({ page }) => {
  await page.goto(address('/', NUMBER, 'lexical'))

  const first = results(page).first()
  await expect(first.locator('mark')).toHaveText(['0.6003'])
  await expect(first.locator('mark')).toBeVisible()
  // The API's markers are gone from what is shown, and the words around the match are still there.
  await expect(first).not.toContainText('«')
  await expect(first).toContainText('REGRESSION lexical: nDCG@10 0.6003 is below the baseline')
})

test('a search opened from a link runs as it was shared', async ({ page, browser }) => {
  await page.goto('/')
  await queryBox(page).fill(QUESTION)
  await page.getByRole('radio', { name: /Vector/ }).check()
  await expect(results(page).first().getByRole('heading')).toHaveText('Glossary: Lease')
  const link = page.url()
  expect(link).toContain('?q=what+happens+if+the+machine+dies+halfway+through+a+job&mode=vector')

  // Someone else, in a browser of their own, opens the link.
  const other = await (await browser.newContext()).newPage()
  await other.goto(link)

  await expect(queryBox(other)).toHaveValue(QUESTION)
  await expect(other.getByRole('radio', { name: /Vector/ })).toBeChecked()
  await expect(results(other).first().getByRole('heading')).toHaveText('Glossary: Lease')
  await expect(other).toHaveTitle(`${QUESTION} | fathom`)
  await other.context().close()
})

test('switching the retriever changes the results and the address, and Back undoes it', async ({ page }) => {
  await page.goto(address('/', QUESTION))
  const top = results(page).first().getByRole('heading')
  await expect(top).toHaveText('ADR 5. Embedding happens after the write, in separate indexer processes: Consequences')

  await page.getByRole('radio', { name: /Vector/ }).check()
  await expect(page).toHaveURL(/&mode=vector$/)
  await expect(top).toHaveText('Glossary: Lease')
  await expect(outcome(page)).toHaveText(/^10 results from vector search/)

  await page.getByRole('radio', { name: /Lexical/ }).check()
  await expect(page).toHaveURL(/&mode=lexical$/)
  await expect(top).toHaveText('ADR 5. Embedding happens after the write, in separate indexer processes: Context')

  await page.goBack()
  await expect(page.getByRole('radio', { name: /Vector/ })).toBeChecked()
  await expect(top).toHaveText('Glossary: Lease')
})

test('the comparison shows the same query three ways', async ({ page }) => {
  await page.goto(address('/compare', QUESTION))
  const [lexical, fused, vector] = [column(page, 'Lexical'), column(page, 'Fused'), column(page, 'Vector')]
  await expect(fused.getByRole('button')).toHaveCount(10)
  await expect(lexical.getByRole('button')).toHaveCount(10)
  await expect(vector.getByRole('button')).toHaveCount(10)
  await expect(outcome(page)).toHaveText('Lexical returned 10 passages, vector 10 passages; 10 passages after fusion.')

  // Each retriever has its own first choice.
  await expect(lexical.getByRole('button').first()).toHaveAccessibleName(named('lexical rank 1', 'Context', 'ADR 5.'))
  await expect(vector.getByRole('button').first()).toHaveAccessibleName(named('vector rank 1', 'Lease', 'Glossary'))

  // Fusion's first choice is neither: it is the passage both rank third, and it starts out selected.
  const top = fused.getByRole('button').first()
  await expect(top).toHaveAccessibleName(
    named('lexical rank 3', 'vector rank 3', 'fused rank 1', 'Consequences', 'ADR 5.'),
  )
  await expect(top).toHaveAttribute('aria-pressed', 'true')
  await expect(lexical.getByRole('button', { name: named('lexical rank 3', 'Consequences') })).toHaveClass(/\bon\b/)
  await expect(vector.getByRole('button', { name: named('vector rank 3', 'Consequences') })).toHaveClass(/\bon\b/)

  // The page works the score out from the two ranks, and the sum is the score the API sent.
  await expect(worked(page).getByRole('heading', { level: 3 })).toHaveText(
    'ADR 5. Embedding happens after the write, in separate indexer processes: Consequences',
  )
  await expect(worked(page).getByRole('row', { name: 'Lexical 3 1 / (10 + 3) = 0.0769' })).toBeVisible()
  await expect(worked(page).getByRole('row', { name: 'Vector 3 1 / (10 + 3) = 0.0769' })).toBeVisible()
  await expect(worked(page).getByRole('row', { name: 'Fused 1 0.1538' })).toBeVisible()

  // The vector retriever's first choice shares no word with the question. The lexical retriever never returns it,
  // one first place is worth less than two thirds, and it ends up further down the fused list.
  const lease = fused.getByRole('button', { name: /Lease/ })
  await expect(lease).toHaveAccessibleName(
    named('not returned by the lexical retriever', 'vector rank 1', 'fused rank'),
  )
  await expect(lease).not.toHaveAccessibleName(/fused rank\s*1\s*,/)
  await lease.click()
  await expect(lease).toHaveAttribute('aria-pressed', 'true')
  await expect(worked(page).getByRole('heading', { level: 3 })).toHaveText('Glossary: Lease')
  await expect(worked(page).getByRole('row', { name: 'Lexical not in its top 50 0' })).toBeVisible()
  await expect(worked(page).getByRole('row', { name: 'Vector 1 1 / (10 + 1) = 0.0909' })).toBeVisible()
  await expect(lexical.getByRole('button', { name: /Lease/ })).toHaveCount(0)
})

test('each example query does what the page says it does', async ({ page }) => {
  await page.goto('/compare')
  const [lexical, fused, vector] = [column(page, 'Lexical'), column(page, 'Fused'), column(page, 'Vector')]
  const first = (list: Locator): Locator => list.getByRole('button').first()

  // "No document contains any of these words, so the lexical retriever returns nothing and the vector retriever
  // finds the entry by meaning."
  await page.getByRole('button', { name: PARAPHRASE }).click()
  await expect(page).toHaveURL(/\/compare\?q=malicious\+javascript\+smuggled\+into\+a\+webpage$/)
  await expect(lexical.getByText('No passage shares a word with this query.')).toBeVisible()
  await expect(lexical.getByRole('button')).toHaveCount(0)
  await expect(first(vector)).toHaveAccessibleName(named('vector rank 1', 'Cross-site scripting', 'Glossary'))
  await expect(first(fused)).toHaveAccessibleName(
    named('not returned by the lexical retriever', 'vector rank 1', 'fused rank 1', 'Cross-site scripting'),
  )

  // "One passage contains it, and the vector retriever does not have that passage in its first ten."
  await page.getByRole('button', { name: NUMBER }).click()
  await expect(lexical.getByRole('button')).toHaveCount(1)
  await expect(first(lexical)).toHaveAccessibleName(named('lexical rank 1', 'Relevance (passage 2)', 'fathom'))
  await expect(first(fused)).toHaveAccessibleName(/lexical rank\s*1\s*,\s*vector rank\s*\d\d\s*,\s*fused rank\s*1\s*,/)
  await expect(first(fused)).toHaveAccessibleName(named('Relevance (passage 2)', 'fathom'))
  await expect(vector.getByRole('button')).toHaveCount(10)
  await expect(vector.getByRole('button', { name: /Relevance.*fathom/ })).toHaveCount(0)
  await expect(vector.getByText('other passages, down to rank 50')).toBeVisible()

  // "Each retriever puts a different passage first, and fusion prefers one that both rank near the top."
  await page.getByRole('button', { name: QUESTION }).click()
  await expect(first(lexical)).toHaveAccessibleName(named('lexical rank 1', 'Context', 'ADR 5.'))
  await expect(first(vector)).toHaveAccessibleName(named('vector rank 1', 'Lease', 'Glossary'))
  await expect(first(fused)).toHaveAccessibleName(
    /lexical rank\s*[2-5]\s*,\s*vector rank\s*[2-5]\s*,\s*fused rank\s*1\s*,\s*Consequences/,
  )

  // "The words are in the answer, and both retrievers put the same two documents on top."
  await page.getByRole('button', { name: AGREED }).click()
  const glossary = named('Reciprocal rank fusion', 'Glossary')
  const decision = /Decision.*ADR 3\. Reciprocal rank fusion, in the application/
  await expect(lexical.getByRole('button').nth(0)).toHaveAccessibleName(glossary)
  await expect(lexical.getByRole('button').nth(1)).toHaveAccessibleName(decision)
  await expect(vector.getByRole('button').nth(0)).toHaveAccessibleName(decision)
  await expect(vector.getByRole('button').nth(1)).toHaveAccessibleName(glossary)
  await expect(first(fused)).toHaveAccessibleName(
    named('lexical rank 1', 'vector rank 2', 'fused rank 1', 'Reciprocal rank fusion', 'Glossary'),
  )
})

test('moving between the views keeps the query and puts focus on the new heading', async ({ page }) => {
  await page.goto(address('/', AGREED))
  await expect(results(page).first()).toBeVisible()

  await page.getByRole('link', { name: 'Compare' }).click()
  await expect(page).toHaveURL(/\/compare\?q=reciprocal\+rank\+fusion\+k$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Compare retrievers' })).toBeFocused()
  await expect(queryBox(page)).toHaveValue(AGREED)
  await expect(column(page, 'Fused').getByRole('button')).toHaveCount(10)

  await page.getByRole('link', { name: 'Search' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeFocused()
  await expect(results(page)).toHaveCount(10)
})

test('the index status says every chunk has a vector', async ({ page }) => {
  await page.goto('/')

  // The seed step does not let the stack report healthy while a chunk is still waiting.
  await expect(indexStatus(page)).toHaveText(/^1\d\d documents in \d{3} chunks, all with vectors\.$/)
})

test('the page never sends or receives an API key', async ({ page, context }) => {
  const requests: Request[] = []
  const responses: Response[] = []
  page.on('request', (request) => requests.push(request))
  page.on('response', (response) => responses.push(response))

  // A whole session: both views, every mode, a query that returns the documentation about keys themselves.
  await page.goto('/')
  await queryBox(page).fill('API key scope')
  await expect(results(page).first()).toBeVisible()
  await page.getByRole('radio', { name: /Lexical/ }).check()
  await expect(outcome(page)).toHaveText(/from lexical search/)
  await page.getByRole('radio', { name: /Vector/ }).check()
  await expect(outcome(page)).toHaveText(/from vector search/)
  await page.getByRole('link', { name: 'Compare' }).click()
  await expect(column(page, 'Fused').getByRole('button')).toHaveCount(10)
  await expect(indexStatus(page)).toContainText('all with vectors')

  const calls = requests.filter((request) => request.url().includes('/api/'))
  // The status line and one search per mode. The comparison then reuses all three answers from the cache.
  expect(calls.length).toBeGreaterThanOrEqual(4)
  for (const request of requests) {
    const headers = await request.allHeaders()
    expect(Object.keys(headers), request.url()).not.toContain('authorization')
    expect(JSON.stringify(headers), request.url()).not.toMatch(API_KEY)
    expect(`${request.url()} ${request.postData() ?? ''}`).not.toMatch(API_KEY)
  }
  for (const response of responses) {
    const headers = await response.allHeaders()
    expect(Object.keys(headers), response.url()).not.toContain('authorization')
    expect(JSON.stringify(headers), response.url()).not.toMatch(API_KEY)
    expect(await response.text(), response.url()).not.toMatch(API_KEY)
  }
  // Nor is one kept anywhere a script could read it later.
  expect(await context.cookies()).toEqual([])
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0])
  expect(await page.content()).not.toMatch(API_KEY)
})

test('the page loads nothing the content security policy refuses', async ({ page }) => {
  const refused: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') refused.push(message.text())
  })
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`securitypolicyviolation ${event.violatedDirective} ${event.blockedURI}`)
    })
  })

  const response = await page.goto(address('/compare', QUESTION))
  await expect(column(page, 'Fused').getByRole('button')).toHaveCount(10)
  await page.getByRole('link', { name: 'Search' }).click()
  await expect(results(page)).toHaveCount(10)

  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'")
  expect(refused).toEqual([])
  // The comparison's lines are drawn, which they would not be if their styles had been refused.
  await page.goBack()
  await expect(page.locator('svg path').first()).toBeAttached()
  expect(
    await page
      .locator('svg path')
      .first()
      .evaluate((path) => getComputedStyle(path).fill),
  ).toBe('none')
})

test('a rate limit is explained, and the search can be repeated', async ({ page }) => {
  await page.route(SEARCH, (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/problem+json',
      headers: { 'Retry-After': '1' },
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Too many requests',
        status: 429,
        detail: 'one address may send 10 searches a second',
      }),
    }),
  )
  await page.goto(address('/', AGREED))

  const alert = page.getByRole('alert')
  await expect(alert.getByRole('heading', { name: 'Too many searches' })).toBeVisible()
  await expect(alert).toContainText('Wait a few seconds, then search again.')
  await expect(outcome(page)).toHaveText('The search failed.')
  await expect(page.getByRole('list', { name: 'Results' })).toHaveCount(0)
  await axe(page)

  // The limiter lets go: the same button now reaches the real API.
  await page.unroute(SEARCH)
  await alert.getByRole('button', { name: 'Search again' }).click()
  await expect(results(page).first().getByRole('heading')).toHaveText('Glossary: Reciprocal rank fusion')
  await expect(alert).toHaveCount(0)
})

test('a server error is shown with the title and detail the API sent', async ({ page }) => {
  await page.route(SEARCH, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Not ready',
        status: 503,
        detail: 'the database is unreachable',
      }),
    }),
  )
  await page.goto(address('/compare', AGREED))

  const alert = page.getByRole('alert')
  await expect(alert.getByRole('heading', { name: 'The search service answered 503: Not ready' })).toBeVisible()
  await expect(alert).toContainText('The database is unreachable. Search again in a moment.')
  await expect(column(page, 'Fused')).toHaveCount(0)
  // The rest of the page still works: the status line comes from another route.
  await expect(indexStatus(page)).toContainText('all with vectors')
})

test('a request that gets no answer is told apart from an error', async ({ page }) => {
  await page.route(SEARCH, (route) => route.abort('connectionrefused'))
  await page.goto(address('/', AGREED))

  const alert = page.getByRole('alert')
  await expect(alert.getByRole('heading', { name: 'No answer from the server' })).toBeVisible()
  await expect(alert).toContainText('Check the connection, then search again.')
})

test('every view passes axe', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: NUMBER })).toBeVisible()
  await expect(indexStatus(page)).toContainText('all with vectors')
  await axe(page)

  await page.goto(address('/', QUESTION))
  await expect(results(page)).toHaveCount(10)
  await axe(page)

  await page.goto(address('/', PARAPHRASE, 'lexical'))
  await expect(page.getByRole('heading', { name: 'Nothing matched' })).toBeVisible()
  await axe(page)

  await page.goto(address('/compare', QUESTION))
  await expect(column(page, 'Fused').getByRole('button')).toHaveCount(10)
  await axe(page)

  // The number has one lexical hit and a fused result that comes from below the vector list's rows.
  await page.goto(address('/compare', NUMBER))
  await expect(column(page, 'Lexical').getByRole('button')).toHaveCount(1)
  await axe(page)

  await page.setViewportSize({ width: 390, height: 800 })
  await expect(column(page, 'Fused').getByRole('button')).toHaveCount(10)
  await axe(page)
})
