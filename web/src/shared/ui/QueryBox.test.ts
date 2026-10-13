// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import QueryBox from './QueryBox.vue'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('QueryBox', () => {
  it('sends what was typed when focus leaves the box, without waiting for the pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const view = render(QueryBox, { props: { query: '' } })

    // Typed, and then at once a click on something else: the 300 ms pause never comes while the box has focus.
    await user.type(screen.getByRole('searchbox', { name: 'Query' }), 'lease expiry deadline')
    expect(view.emitted().search).toBeUndefined()
    await user.tab()

    expect(view.emitted().search).toEqual([['lease expiry deadline']])
    // And the pause, when it does come, does not send the same text again.
    await vi.advanceTimersByTimeAsync(1000)
    expect(view.emitted().search).toHaveLength(1)
  })

  it('sends nothing on leaving the box when nothing was changed', async () => {
    const user = userEvent.setup()
    const view = render(QueryBox, { props: { query: 'lease' } })

    await user.click(screen.getByRole('searchbox', { name: 'Query' }))
    await user.tab()

    expect(view.emitted().search).toBeUndefined()
  })
})
