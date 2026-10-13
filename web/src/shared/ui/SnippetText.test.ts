// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/vue'
import { afterEach, describe, expect, it } from 'vitest'

import SnippetText from './SnippetText.vue'

afterEach(cleanup)

describe('SnippetText', () => {
  it('shows markup inside a document as text and never builds an element from it', () => {
    // What a hostile document could put in a snippet: a tag with a handler outside a match, tags inside a match,
    // and markers nested and left open to confuse the splitting.
    const snippet =
      'see <img src=x onerror=alert(1)> and «<script>alert(2)</script>» then «a «<b onclick=x>bold</b>» c» and «open'

    const { container } = render(SnippetText, { props: { snippet } })

    expect(container.querySelector('img, script, b')).toBeNull()
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
      '<script>alert(2)</script>',
      '<b onclick=x>bold</b>',
    ])
    expect(container.querySelectorAll('p *')).toHaveLength(2)
    expect(container.textContent).toBe(
      'see <img src=x onerror=alert(1)> and <script>alert(2)</script> then «a <b onclick=x>bold</b> c» and «open',
    )
  })

  it('keeps the spaces between a match and the words around it', () => {
    const { container } = render(SnippetText, { props: { snippet: 'the «tower» was «designed» by' } })

    expect(container.textContent).toBe('the tower was designed by')
  })
})
