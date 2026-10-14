// Queries against the seeded corpus where the two retrievers visibly disagree. Each claim below is asserted against
// the real stack by a journey (e2e/journeys.spec.ts), so an edit to the corpus that makes one untrue fails the build.
// None of them may be quoted in the documentation: the documentation is the corpus (ADR 9).

export interface Example {
  query: string
  shows: string
}

export const EXAMPLES: Example[] = [
  {
    query: 'malicious javascript smuggled into a webpage',
    shows:
      'A paraphrase. No document contains any of these words, so the lexical retriever returns nothing and the vector retriever finds the entry by meaning.',
  },
  {
    query: '0.6003',
    shows:
      'An exact number. One passage contains it: the lexical retriever returns that passage and nothing else, and the vector retriever puts other passages first.',
  },
  {
    query: 'what happens if the machine dies halfway through a job',
    shows:
      'A question. Each retriever puts a different passage first, and the first fused result is one that both have in their first ten.',
  },
  {
    query: 'reciprocal rank fusion k',
    shows: 'For contrast: the words are in the answer, and both retrievers put the same two documents on top.',
  },
]
