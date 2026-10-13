# 9. The demo corpus is this repository's documentation, sent through the API

## Context

The console needs something to search, present from the first `docker compose up`. The repository is MIT, so whatever
is committed has to be MIT or freer: SQuAD and Wikipedia text are share-alike and stay out, which is why the evaluation
downloads SQuAD at run time (ADR 4). An indexer embeds roughly 9 to 18 paragraphs a second on a laptop
(`docs/benchmark-results`), and the stack should not take minutes to start. And the corpus has to be one in which the
two retrievers visibly disagree, or the comparison view has nothing to show.

## Decision

The corpus is the markdown in this repository: the top-level documents (README, CHANGELOG, CONTRIBUTING, SECURITY),
everything under `docs/`, and `corpus/glossary.md`, a set of short entries on the terms the ADRs use, written for this
purpose and MIT like the rest.

`tools/seed.py` turns each file into one document per second-level section. The id comes from the path and the
heading, so it is the same on every run. The title is the document's title followed by the section's. Markdown markup
is removed so that a snippet reads as text. The file, the document and the section go into the metadata. The script
sends the documents through the HTTP API, in batches of 100, with a write key it creates and revokes; the API chunks
them as it chunks anything (180 words by default). The collection is called `demo`.

The script is safe to run again, and it runs on every `up`:

- A section the API already has comes back `unchanged` and nothing is written. The second start of a stack logs
  `0 written, N unchanged`.
- A section that an earlier run sent and that is no longer in the corpus is deleted. The list of what was sent is kept
  next to the proxy's key.
- It exits only when the collection's `pending` count is 0. Compose starts the web container after the script has
  finished, so `--wait` returns when every chunk has a vector and not before.

`test_a_file_becomes_one_document_per_section_that_has_text` and its neighbours in `tests/unit/test_seed.py` cover the
splitting, and `test_the_committed_corpus_is_something_the_api_accepts` runs it over the real files.

## Consequences

- At this commit that is 135 documents in 167 chunks. On the laptop in `docs/benchmark-results`, with the images
  already built, a stack with an empty database was healthy 30 seconds after `docker compose up --wait`, 14 of them
  spent embedding. A second run, while another build was using the machine, took 47 and 25.
- Editing the documentation changes what the demo returns. The four example queries on the page each make a claim
  about the result ("the lexical retriever returns nothing", "both put the same two passages on top"), and
  `web/e2e/journeys.spec.ts` asserts each claim against the real stack. An edit that makes one untrue fails CI, and the
  fix is to choose another example, not to bend the corpus.
- The corpus is small. The vector retriever returns its 50 nearest chunks whatever the query, and 50 is nearly a third
  of this collection, so here "not among the vector retriever's candidates" means the bottom two thirds. In a
  collection of a million chunks the same words would mean much more.
- Every document is about the same subject and written by the same hand, so queries and answers share vocabulary more
  than they would in the wild. The console shows how the two rankings combine. It measures nothing: the numbers in the
  README come from the SQuAD evaluation.
- The seed step reads the files from the checkout through bind mounts. The demo therefore runs from a clone of the
  repository, not from the two images alone.
- The examples on the page must not be quoted in the documentation. A document that repeats a query contains its words,
  and the lexical retriever would find that document.

## Alternatives

- **A slice of SQuAD or of Wikipedia.** Larger and more varied, and the licence does not allow committing it. Fetching
  it when the stack starts would make the quick start depend on someone else's server. It stays the right choice for
  measuring relevance.
- **A public-domain book.** Clean to commit and as large as needed. It lost because nobody opening this repository has
  a question about Moby-Dick: with the documentation as the corpus, the first query a reader tries is one they wanted
  answered anyway. It would win if the demo had to show scale.
- **A `fathom seed` command that writes to the database directly.** One process fewer. It would put a demo's concern
  into the product's command line and skip the API, whose `202` and `unchanged` answers are what makes the seed step
  safe to repeat. It would win if seeding had to work with the API down.
- **One document per file.** About twenty documents. Results are collapsed to the best chunk per document, so most
  queries would return most of the corpus and the two rankings would rarely differ by more than their order.
