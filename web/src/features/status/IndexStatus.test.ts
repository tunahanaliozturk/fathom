// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '@/shared/api/queries'
import { json, network, problem } from '@/test/network'

import IndexStatus from './IndexStatus.vue'

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const line = () => screen.getByRole('status').textContent

describe('the index status line', () => {
  it('says how much is indexed once every chunk has a vector, and stops asking', async () => {
    const calls = network(() => json({ documents: 121, chunks: 128, pending: 0 }))

    render(IndexStatus)

    expect(line()).toBe('Reading the index.')
    await waitFor(() => expect(line()).toBe('121 documents in 128 chunks, all with vectors.'))
    expect(calls.map((call) => call.url)).toEqual(['/api/v1/collections/demo/stats'])
  })

  it('says that text search is ahead of the vectors while chunks are waiting, and asks again until none are', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let pending = 12
    const calls = network(() => json({ documents: 121, chunks: 128, pending }))

    render(IndexStatus)
    await vi.advanceTimersByTimeAsync(0)

    expect(line()).toBe('121 documents in 128 chunks; 12 still waiting for a vector and found by text only.')

    pending = 0
    await vi.advanceTimersByTimeAsync(2000)

    expect(line()).toBe('121 documents in 128 chunks, all with vectors.')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(2)
  })

  it('says that the status is unavailable instead of showing nothing', async () => {
    network(() => problem(503, 'Not ready', 'the database is unreachable'))

    render(IndexStatus)

    await waitFor(() => expect(line()).toBe('Index status is unavailable.'))
  })
})
