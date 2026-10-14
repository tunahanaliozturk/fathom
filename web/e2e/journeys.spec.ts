// The journeys the console exists for, against the real stack: nginx, the API, the embedding model, the indexer,
// Postgres, and the corpus the seed step sent. Nothing here writes, so the tests can run side by side and again.
//
// The corpus is this repository's documentation (ADR 9), so an edit to a document can move a rank. The journeys
// therefore read ranks and scores from the page and check what the page derives from them, and assert a title or a
// relation between ranks only where the page itself makes that claim (the four examples), with the room there is
// around each one noted beside it. When an edit does move one, the failure is the reminder to look at that example.

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

/** A comparison row for `passage`, whatever ranks its name starts with. */
const ending = (passage: string): RegExp => new RegExp(`, ${passage.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}$`)

/** What a comparison row says of itself: its ranks, and the passage. `null` where a retriever did not return it. */
async function rowOf(row: Locator): Promise<{ lexical: number | null; vector: number | null; passage: string }> {
  const name = (await row.getAttribute('aria-label')) ?? ''
  const rank = (retriever: string): number | null => {
    const found = new RegExp(`${retriever} rank (\\d+)`).exec(name)
    return found === null ? null : Number(found[1])
  }
  // The name is "…rank 3, …rank 2, fused rank 1, Section, Document": the passage is what follows the last rank.
  const passage = name.replace(/^.*(?:rank \d+|retriever), /, '')
  return { lexical: rank('lexical'), vector: rank('vector'), passage }
}

/** The document a row is about, without the part that says which of its passages. */
const documentOf = (passage: string): string => passage.replace(/ \(passage \d+\)/, '')

/** A row of the worked score, as the page writes it for a rank. */
const adds = (rank: number): string => `1 / (10 + ${rank}) = ${(1 / (10 + rank)).toFixed(4)}`

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
  await expect(results(page).first().getByRole('heading')).toHaveText(/reciprocal rank fusion/i)
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
  // The page's clock is held and moved by hand, so the pause is exactly as long as this test says it is.
  await page.clock.install({ time: new Date('2026-10-13T12:00:00Z') })
  await page.goto('/')
  await expect(queryBox(page)).toBeVisible()
  await page.clock.pauseAt(new Date('2026-10-13T12:01:00Z'))

  await queryBox(page).pressSequentially('constant time comparison')
  await page.clock.runFor(299)
  expect(sent).toHaveLength(0)
  await page.clock.runFor(1)
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toContain('"query":"constant time comparison"')

  await page.clock.resume()
  await expect(results(page).first().getByRole('heading')).toHaveText(/constant-time comparison/i)
  expect(sent).toHaveLength(1)
})

test('an example chosen from the keyboard leaves focus in the query box', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible()

  // Skip link, two views, the query box, the retriever, then the first example.
  for (let stop = 0; stop < 6; stop += 1) await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: PARAPHRASE })).toBeFocused()
  await page.keyboard.press('Enter')

  // The examples are gone, and with them the button that had focus. It must not fall back to the page.
  await expect(results(page).first()).toBeVisible()
  await expect(queryBox(page)).toBeFocused()
  await expect(queryBox(page)).toHaveValue(PARAPHRASE)
  // And the keyboard goes on from there.
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(NUMBER)
  await expect(results(page).first().getByRole('heading')).toHaveText('fathom: Relevance')
})

test('text typed just before leaving the view goes along to the other view', async ({ page }) => {
  await page.goto('/')

  // Filled, and at once a click elsewhere: the 300 ms pause never passes while the box has focus.
  await queryBox(page).fill('lease expiry deadline')
  await page.getByRole('link', { name: 'Compare' }).click()

  await expect(page).toHaveURL(/\/compare\?q=lease\+expiry\+deadline$/)
  await expect(queryBox(page)).toHaveValue('lease expiry deadline')
})

test('a paraphrase is found by the vector retriever and not by the lexical one', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: PARAPHRASE }).click()
  await expect(queryBox(page)).toHaveValue(PARAPHRASE)

  // Hybrid: the glossary entry that answers it is found by the vector retriever alone. It was first when this was
  // written; the assertion allows it to be third, since a new document about the same thing could pass it.
  const entry = results(page).filter({ hasText: 'Glossary: Cross-site scripting' })
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText('corpus/glossary.md')
  await expect(readout(entry).lexical).toHaveText('not in its top 50')
  const rank = Number((await readout(entry).vector.innerText()).replace(/\D/g, ''))
  expect(rank).toBeGreaterThanOrEqual(1)
  expect(rank).toBeLessThanOrEqual(3)
  // One retriever, one term: the score is what that rank alone adds.
  await expect(readout(entry).score).toHaveText((1 / (10 + rank)).toFixed(4))

  // Lexical: not one of the query's words is in the corpus (ADR 9 keeps the examples out of the documentation).
  await page.getByRole('radio', { name: /Lexical/ }).check()
  await expect(page.getByRole('heading', { name: 'Nothing matched' })).toBeVisible()
  await expect(page.getByText('needs at least one word in common')).toBeVisible()
  await expect(outcome(page)).toHaveText('No results.')

  // Vector: the same entry, and the page says that the lexical retriever was not asked.
  await page.getByRole('radio', { name: /Vector/ }).check()
  await expect(entry).toHaveCount(1)
  await expect(readout(entry).lexical).toHaveText('not run')
})

test('an exact number is found by the lexical retriever, and fusion puts it first', async ({ page }) => {
  await page.goto(address('/', NUMBER))

  // The number is in one passage of the README. The lexical retriever returns that passage and nothing else, which
  // is enough to put it first: a lexical first place alone ties with the best the vector retriever can give.
  const first = results(page).first()
  await expect(first.getByRole('heading')).toHaveText('fathom: Relevance')
  await expect(readout(first).lexical).toHaveText(/^rank\s*1$/)
  // To the vector retriever a number means little. It ranked the passage 13th when this was written; the claim
  // on the page is only that other passages come first, which leaves it eleven places of room.
  const vector = /\d+/.exec(await readout(first).vector.innerText())
  const vectorRank = vector === null ? null : Number(vector[0])
  expect(vectorRank === null || vectorRank > 1).toBe(true)
  // What fusion made of the two ranks is the score the API returned.
  await expect(readout(first).score).toHaveText((1 / 11 + (vectorRank === null ? 0 : 1 / (10 + vectorRank))).toFixed(4))

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
  await expect(first).toContainText('0.6003 is below the baseline')
})

test('guillemets that belong to a document are shown, not taken for the marks of a match', async ({ page }) => {
  // The documentation describes the API's markers, so some passages contain the two characters themselves. The
  // words of this query are in one of those passages.
  await page.goto(address('/', 'API marks matches escape anything', 'lexical'))

  const passage = results(page).filter({ hasText: 'plain text with « and »' }).first()
  await expect(passage).toBeVisible()
  const marked = await passage.locator('mark').allTextContents()
  expect(marked.length).toBeGreaterThan(0)
  // A match is one word. The "and" between the document's own pair is not one.
  for (const text of marked) expect(text).toMatch(/^[^\s«»]+$/)
  expect(marked.map((text) => text.trim().toLowerCase())).not.toContain('and')
})

test('a search opened from a link runs as it was shared', async ({ page, browser }) => {
  await page.goto('/')
  await queryBox(page).fill(QUESTION)
  await page.getByRole('radio', { name: /Vector/ }).check()
  await expect(outcome(page)).toHaveText(/from vector search/)
  const shown = await results(page).getByRole('heading').allTextContents()
  const link = page.url()
  expect(link).toContain('?q=what+happens+if+the+machine+dies+halfway+through+a+job&mode=vector')

  // Someone else, in a browser of their own, opens the link, and sees the same list.
  const other = await (await browser.newContext()).newPage()
  await other.goto(link)

  await expect(queryBox(other)).toHaveValue(QUESTION)
  await expect(other.getByRole('radio', { name: /Vector/ })).toBeChecked()
  await expect(results(other).getByRole('heading')).toHaveText(shown)
  await expect(other).toHaveTitle(`${QUESTION} | fathom`)
  await other.context().close()
})

test('switching the retriever changes the results and the address, and Back undoes it', async ({ page }) => {
  await page.goto(address('/', QUESTION))
  const top = results(page).first().getByRole('heading')
  await expect(outcome(page)).toHaveText(/from hybrid search/)

  await page.getByRole('radio', { name: /Vector/ }).check()
  await expect(page).toHaveURL(/&mode=vector$/)
  await expect(outcome(page)).toHaveText(/^10 results from vector search/)
  const byMeaning = await top.innerText()

  await page.getByRole('radio', { name: /Lexical/ }).check()
  await expect(page).toHaveURL(/&mode=lexical$/)
  await expect(outcome(page)).toHaveText(/from lexical search/)
  // The example's claim: for this question each retriever puts a different passage first.
  await expect(top).not.toHaveText(byMeaning)

  await page.goBack()
  await expect(page.getByRole('radio', { name: /Vector/ })).toBeChecked()
  await expect(top).toHaveText(byMeaning)
})

test('the comparison shows the same query three ways', async ({ page }) => {
  await page.goto(address('/compare', QUESTION))
  const [lexical, fused, vector] = [column(page, 'Lexical'), column(page, 'Fused'), column(page, 'Vector')]
  await expect(fused.getByRole('button')).toHaveCount(10)
  await expect(lexical.getByRole('button')).toHaveCount(10)
  await expect(vector.getByRole('button')).toHaveCount(10)
  await expect(outcome(page)).toHaveText('Lexical returned 10 passages, vector 10 passages; 10 passages after fusion.')

  // The first fused result starts out selected, and its rows in the other two lists are marked with it.
  const top = fused.getByRole('button').first()
  await expect(top).toHaveAttribute('aria-pressed', 'true')
  const first = await rowOf(top)
  if (first.lexical === null || first.vector === null) throw new Error('the first fused result has both ranks')
  await expect(lexical.getByRole('button', { name: `lexical rank ${first.lexical}, ${first.passage}` })).toHaveClass(
    /\bon\b/,
  )
  await expect(vector.getByRole('button', { name: `vector rank ${first.vector}, ${first.passage}` })).toHaveClass(
    /\bon\b/,
  )

  // The page works the score out from the two ranks in that row. The total is the API's score, and it is what the
  // two ranks add up to.
  await expect(worked(page).getByRole('row', { name: `Lexical ${first.lexical} ${adds(first.lexical)}` })).toBeVisible()
  await expect(worked(page).getByRole('row', { name: `Vector ${first.vector} ${adds(first.vector)}` })).toBeVisible()
  const total = (1 / (10 + first.lexical) + 1 / (10 + first.vector)).toFixed(4)
  await expect(worked(page).getByRole('row', { name: `Fused 1 ${total}` })).toBeVisible()
  await expect(worked(page)).toContainText('Each figure is rounded to four places')

  // A passage the lexical retriever never returned: the vector retriever's own first choice, which shares no word
  // with the question. One first place is worth less than two places near the top, so it is not the first fused
  // result, and its row has no line on the lexical side.
  const alone = fused.getByRole('button', { name: /^not returned by the lexical retriever, vector rank 1, / })
  await expect(alone).toHaveCount(1)
  await expect(alone).not.toHaveAccessibleName(/fused rank 1,/)
  const lone = await rowOf(alone)
  await alone.click()
  await expect(alone).toHaveAttribute('aria-pressed', 'true')
  await expect(worked(page).getByRole('row', { name: 'Lexical not in its top 50 0' })).toBeVisible()
  await expect(worked(page).getByRole('row', { name: `Vector 1 ${adds(1)}` })).toBeVisible()
  await expect(lexical.getByRole('button', { name: ending(lone.passage) })).toHaveCount(0)
  // Pinning is announced: the section it rewrites is under the picture, out of a screen reader's view.
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Worked out below' })).toContainText(
    'Not returned by the lexical retriever, vector rank 1, fused rank',
  )
})

test('each example query does what the page says it does', async ({ page }) => {
  await page.goto('/compare')
  const [lexical, fused, vector] = [column(page, 'Lexical'), column(page, 'Fused'), column(page, 'Vector')]
  const first = (list: Locator): Locator => list.getByRole('button').first()

  // "No document contains any of these words, so the lexical retriever returns nothing and the vector retriever
  // finds the entry by meaning." Room: none of the four words may appear in the documentation (ADR 9); the entry was
  // the vector retriever's first choice when this was written and may be its third.
  await page.getByRole('button', { name: PARAPHRASE }).click()
  await expect(page).toHaveURL(/\/compare\?q=malicious\+javascript\+smuggled\+into\+a\+webpage$/)
  await expect(lexical.getByText('No passage shares a word with this query.')).toBeVisible()
  await expect(lexical.getByRole('button')).toHaveCount(0)
  const entry = fused.getByRole('button', { name: /, Cross-site scripting, Glossary$/ })
  await expect(entry).toHaveAccessibleName(
    /^not returned by the lexical retriever, vector rank [123], fused rank [123], /,
  )

  // "One passage contains it: the lexical retriever returns that passage and nothing else, and the vector retriever
  // puts other passages first." Room: the passage was the vector retriever's 13th, and the claim holds down to 2nd.
  await page.getByRole('button', { name: NUMBER }).click()
  await expect(lexical.getByRole('button')).toHaveCount(1)
  const only = await rowOf(first(lexical))
  expect(only.lexical).toBe(1)
  expect(documentOf(only.passage)).toBe('Relevance, fathom')
  const number = await rowOf(first(fused))
  expect(number.passage).toBe(only.passage)
  expect(number.lexical).toBe(1)
  expect(number.vector === null || number.vector > 1).toBe(true)
  expect((await rowOf(first(vector))).passage).not.toBe(only.passage)

  // "Each retriever puts a different passage first, and the first fused result is one that both have in their first
  // ten." Room: the fused winner had ranks 3 and 3; any pair up to 10 and 10 keeps the claim.
  await page.getByRole('button', { name: QUESTION }).click()
  await expect(fused.getByRole('button')).toHaveCount(10)
  await expect(outcome(page)).toHaveText(/after fusion\.$/)
  expect((await rowOf(first(lexical))).passage).not.toBe((await rowOf(first(vector))).passage)
  const winner = await rowOf(first(fused))
  expect(winner.lexical).not.toBeNull()
  expect(winner.vector).not.toBeNull()
  await expect(lexical.getByRole('button', { name: ending(winner.passage) })).toHaveCount(1)
  await expect(vector.getByRole('button', { name: ending(winner.passage) })).toHaveCount(1)

  // "The words are in the answer, and both retrievers put the same two documents on top." Room: the two are the
  // glossary entry and the ADR's decision, whose titles are the query; their order may differ between the lists.
  await page.getByRole('button', { name: AGREED }).click()
  await expect(outcome(page)).toHaveText(/after fusion\.$/)
  await expect(first(fused)).toHaveAccessibleName(/Reciprocal rank fusion/)
  const topTwo = async (list: Locator): Promise<string[]> =>
    [
      documentOf((await rowOf(list.getByRole('button').nth(0))).passage),
      documentOf((await rowOf(list.getByRole('button').nth(1))).passage),
    ].sort()
  expect(await topTwo(lexical)).toEqual(await topTwo(vector))
  expect(await topTwo(lexical)).toContain(documentOf((await rowOf(first(fused))).passage))
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

test('a view whose script is gone after a deploy is fetched by loading the page again', async ({ page }) => {
  await page.goto(address('/', AGREED))
  await expect(results(page).first()).toBeVisible()
  // What a tab left open across a deploy runs into: the file it knows the other view by is no longer there. Once.
  await page.route('**/assets/CompareView-*.js', (route) => route.abort(), { times: 1 })

  await page.getByRole('link', { name: 'Compare' }).click()

  // Without the reload the click would do nothing at all, and say nothing.
  await expect(page).toHaveURL(/\/compare\?q=reciprocal\+rank\+fusion\+k$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Compare retrievers' })).toBeVisible()
  await expect(column(page, 'Fused').getByRole('button')).toHaveCount(10)
  // The note that guards against reloading for ever is cleared once a navigation has worked.
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
})

test('the index status says every chunk has a vector', async ({ page }) => {
  await page.goto('/')

  // The seed step does not let the stack report healthy while a chunk is still waiting.
  await expect(indexStatus(page)).toHaveText(/^\d+ documents in \d+ chunks, all with vectors\.$/)
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
        detail: 'this address is sending requests faster than the proxy allows',
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
  await alert.getByRole('button', { name: 'Search again' }).focus()
  await page.keyboard.press('Enter')
  await expect(results(page).first().getByRole('heading')).toHaveText(/reciprocal rank fusion/i)
  await expect(alert).toHaveCount(0)
  // The button went with the failure. Focus is in the query box, not on the page as a whole.
  await expect(queryBox(page)).toBeFocused()
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

// One test per state, so that a slow machine runs out of time on none of them and a violation names its view.
const views: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: 'the search view before a query',
    open: async (page) => {
      await page.goto('/')
      await expect(page.getByRole('button', { name: NUMBER })).toBeVisible()
      await expect(indexStatus(page)).toContainText('all with vectors')
    },
  },
  {
    name: 'the search view with results',
    open: async (page) => {
      await page.goto(address('/', QUESTION))
      await expect(results(page)).toHaveCount(10)
    },
  },
  {
    name: 'the search view with no results',
    open: async (page) => {
      await page.goto(address('/', PARAPHRASE, 'lexical'))
      await expect(page.getByRole('heading', { name: 'Nothing matched' })).toBeVisible()
    },
  },
  {
    name: 'the comparison',
    open: async (page) => {
      await page.goto(address('/compare', QUESTION))
      await expect(column(page, 'Fused').getByRole('button')).toHaveCount(10)
    },
  },
  {
    // One lexical hit, and a fused result that comes from below the vector list's rows.
    name: 'the comparison when the lists are uneven',
    open: async (page) => {
      await page.goto(address('/compare', NUMBER))
      await expect(column(page, 'Lexical').getByRole('button')).toHaveCount(1)
    },
  },
  {
    name: 'the comparison on a narrow screen',
    open: async (page) => {
      await page.setViewportSize({ width: 390, height: 800 })
      await page.goto(address('/compare', QUESTION))
      await expect(column(page, 'Fused').getByRole('button')).toHaveCount(10)
    },
  },
]

for (const view of views) {
  test(`axe finds nothing wrong with ${view.name}`, async ({ page }) => {
    await view.open(page)
    await axe(page)
  })
}
