// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiFailure } from '@/shared/api/fathom'

import FailureNote from './FailureNote.vue'

afterEach(cleanup)

// The views show these through a failed search (SearchView.test.ts). What is left for here are the cases a real
// server rarely produces.
describe('FailureNote', () => {
  it('says that a refusal came with no explanation when it did', () => {
    render(FailureNote, { props: { failure: new ApiFailure('refused', 403, 'Forbidden', '') } })

    expect(screen.getByRole('heading', { name: 'The server refused the search (403 Forbidden)' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('It gave no detail.')
  })

  it('keeps the full stop of a detail that already ends in one', () => {
    render(FailureNote, { props: { failure: new ApiFailure('server', 500, 'Error', 'Out of memory.') } })

    expect(screen.getByRole('alert').textContent).toContain('Out of memory. Search again in a moment.')
  })

  it('shows an error it did not expect in its own words, and still offers to search again', async () => {
    const user = userEvent.setup()
    const view = render(FailureNote, { props: { failure: new RangeError('Maximum call stack size exceeded') } })

    expect(screen.getByRole('heading', { name: 'The search stopped' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Maximum call stack size exceeded')

    await user.click(screen.getByRole('button', { name: 'Search again' }))
    expect(view.emitted().retry).toHaveLength(1)
  })
})
