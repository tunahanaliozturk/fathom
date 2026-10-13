# Glossary

Short notes on the terms the ADRs and the evaluation use. They were written for this repository, are MIT licensed like
the rest of it, and are part of the demo corpus (ADR 9): one entry is one document.

## Tokenisation

Before text can be indexed it is cut into tokens. Postgres' default parser splits on whitespace and punctuation, and
also recognises things like numbers, e-mail addresses and file paths as single tokens. An identifier such as
`ts_rank_cd` comes out as three tokens, because the underscore is a separator. What the parser does decides what an
exact search can find later.

## Stemming

Reducing a word to its root so that different grammatical forms land on the same index entry: "running", "runs" and
"ran" are treated as one term, as far as the algorithm can tell. Postgres' `english` configuration uses the Snowball
stemmer. It is why a query for "indexes" finds a passage that says "indexing", and also why it sometimes conflates
words that only look related.

## Stop words

Very common words ("the", "of", "is") that carry almost no information for ranking. The `english` configuration drops
them at index time and at query time. A query made only of stop words has nothing left to look up, which is why
fathom's lexical retriever returns no rows for it instead of failing.

## Inverted index

The data structure behind full-text search: for every term, the list of places where it occurs. Looking up a term is
then one read rather than a scan of every document. In Postgres the GIN index over a `tsvector` column plays this
role.

## tsvector

Postgres' stored form of a document for text search: the sorted list of its stemmed terms, each with the positions
where it occurs and an optional weight from A to D. fathom keeps one per chunk as a generated column, with the title
at weight A and the body at weight B, so it can never disagree with the text it was built from.

## tsquery

Postgres' parsed form of a search: stemmed terms joined by AND, OR, NOT and the "followed by" operator. The functions
that build one from user input (`plainto_tsquery`, `websearch_to_tsquery`) join the terms with AND. fathom rewrites
that to OR, for the reason ADR 2 gives.

## Conjunctive and disjunctive queries

A conjunctive query requires every term (AND); a disjunctive one accepts any of them (OR). AND suits a search box,
where people type the two or three words they expect to see. It fails on a question written as a sentence, because the
passage that answers it rarely repeats all of its words. OR finds more and leaves the sorting to the ranking function.

## Term frequency

How often a term occurs in one document. More occurrences suggest the document is about the term, with diminishing
returns: the tenth occurrence says less than the second. Ranking functions dampen it, usually with a logarithm or a
saturation curve.

## Inverse document frequency

A weight that grows as a term gets rarer across the whole collection. A match on "pgvector" should count for more than
a match on "search" in a corpus where every page says "search". Postgres' `ts_rank` does not use collection statistics
at all, which is the main way it differs from BM25.

## BM25

The ranking function most search engines default to. It combines term frequency with saturation, inverse document
frequency, and a correction for document length. Postgres does not ship it. fathom measures what the built-in
alternative costs on its evaluation set rather than assuming (ADR 2).

## ts_rank

Postgres' basic ranking function for text search. It scores a document by how often the query's terms occur in it and
by their weights, optionally normalised by length. On OR queries it rewards covering more of the query's distinct
terms, which is what a question needs.

## Cover density

A ranking idea that scores how close together the query's terms appear: the shorter the span that contains them all,
the better. Postgres implements it as `ts_rank_cd`. It suits AND queries. On OR queries it rewards a passage that
repeats one term tightly over a passage that mentions several, and in fathom's evaluation that took lexical nDCG from
0.846 to 0.600.

## Length normalisation

Long documents contain more terms and so match more queries by accident. Dividing the score by some function of the
length corrects for it. fathom passes normalisation flag 1 to `ts_rank`, which divides by one plus the logarithm of
the length.

## GIN

Generalised inverted index, the Postgres index type for values that contain many keys: the terms of a `tsvector`, the
elements of an array, the pairs of a `jsonb` object. fathom has two, one for text search and one for metadata
containment filters.

## Embedding

A fixed-length list of numbers produced by a model from a piece of text, arranged so that texts with similar meaning
get nearby lists. fathom's default model produces 384 numbers per chunk. Two passages can be neighbours without
sharing a single word, which is the whole reason to keep a second retriever.

## Bi-encoder

A model that turns the query and each passage into a point separately, so passage points can be computed once and
stored. Search is then a nearest-neighbour lookup. It is fast and it scales, at the price of never looking at the
query and the passage side by side.

## Cross-encoder

A model that reads the query and one passage together and outputs a relevance score. It is more accurate than
comparing two separately computed points and far slower, since it runs once per candidate. It is normally used to
reorder the top few dozen results of a cheaper retriever. fathom does not have one.

## Cosine distance

One minus the cosine of the angle between two lists of numbers. It ignores their lengths and compares only direction.
pgvector's `<=>` operator computes it, and the HNSW index in fathom is built for that operator.

## Nearest-neighbour search

Finding the stored points closest to a query point. Doing it exactly means comparing against every row. That is
affordable for a few thousand rows and not for a few million, which is where approximate indexes come in.

## Approximate nearest neighbours

Index structures that find most of the true closest points while looking at a small part of the data. They trade a
little recall for a large gain in speed, and the trade is tunable. Whether the loss matters is a question for an
evaluation set, not for intuition.

## HNSW

Hierarchical navigable small world: a layered graph in which each point links to some of its neighbours. A search
enters at the sparse top layer and walks greedily downwards, toward the query. pgvector builds one with the parameters
`m` (links per point) and `ef_construction` (how hard to look for good links while building).

## ef_search

The size of the candidate list an HNSW search keeps while it walks the graph. Larger values find more of the true
neighbours and take longer. It can never usefully be smaller than the number of rows asked for, so fathom raises it to
at least the candidate count.

## Iterative scan

A pgvector 0.8 feature. When a filter rejects most of the rows an HNSW search finds, the plain search returns too few.
An iterative scan keeps walking the graph until enough rows pass the filter. In relaxed order mode it may hand them
back slightly out of sequence, so fathom sorts the result again.

## Pre-filtering and post-filtering

Two places to apply a metadata condition in a vector search. Filtering afterwards is simple and can leave fewer results
than asked for. Filtering first is exact and may not be able to use the vector index. fathom applies the condition
inside both retrievers' queries, with iterative scans on the vector side.

## Hybrid search

Running a lexical retriever and a vector retriever for the same query and merging their results. The two fail in
different ways: one needs shared words, the other blurs exact names and numbers. The merged list is better than either
only if the merging step does not let one of them drown the other.

## Rank fusion

Merging several ranked lists using positions only, never the raw scores. It avoids the problem that a text score and
a vector distance have no common scale. The cost is that a result's margin is thrown away: first by a hair and first
by a mile look the same.

## Reciprocal rank fusion

Each list gives an item one over (k plus its rank); the item's fused score is the sum over the lists that contain it.
An item both retrievers place third beats an item one places first and the other never returns, when k is 10. The
constant k decides how much the very top positions are worth relative to the rest.

## Score normalisation

Rescaling each retriever's scores to a common range, for instance zero to one, before adding them with weights. It
keeps the information in the margins that rank fusion discards. It is also sensitive to outliers in each list, and
weights tuned on one corpus do not carry over to another.

## Candidates

How many results each retriever contributes before fusion. fathom takes 50 from each. A document that the lexical
retriever puts at position 51 does not exist as far as fusion is concerned, so the number bounds what hybrid search
can recover.

## Chunking

Cutting a document into passages small enough to embed and to show as a result. fathom cuts on sentence boundaries up
to a word budget. Too large and a passage mixes several topics into one blurred point; too small and it loses the
context that made it an answer.

## Chunk overlap

Repeating the last sentence or two of one passage at the start of the next, so a fact that straddles a boundary is
whole in at least one of them. It costs some storage and some duplicate matches, which collapsing results by document
then hides.

## Collapsing

Keeping only the best passage per document in a result list. Without it a long document that matches well can take
every one of the first ten places. With it, the ranks a retriever reports count passages while the list shows
documents, so the two numbers can differ.

## Snippet

The short extract shown under a result, usually the part of the passage that contains the query's terms. Postgres'
`ts_headline` builds it and marks the matches. It works from the text query, so a result found only by the vector
retriever can have a snippet with nothing marked in it.

## Recall

Of the documents that are relevant to a query, the share the system returned. Recall at 10 asks whether the right
passage is anywhere on the first page. It says nothing about whether it was first or tenth.

## Precision

Of the documents the system returned, the share that are relevant. With one correct passage per question, as in
fathom's evaluation, precision at 10 can never exceed one in ten, so the evaluation reports rank-aware measures
instead.

## Mean reciprocal rank

The average, over many queries, of one divided by the position of the first relevant result. First place scores 1,
second a half, third a third. It rewards getting the answer to the very top and is easy to explain to someone who has
not met it before.

## nDCG

Normalised discounted cumulative gain. Each relevant result contributes a gain discounted by the logarithm of its
position, and the sum is divided by the best achievable sum, giving a number between 0 and 1. fathom's build gate
watches nDCG at 10 for each mode.

## Relevance judgments

The record of which documents are right for which queries, against which a ranking is scored. Writing them by hand is
slow. A question-answering dataset supplies them for free, since each question came from a known paragraph, at the
price of questions that echo their source's wording.

## Regression gate

A check in continuous integration that compares a measured quality number with a stored baseline and fails the build
when it falls by more than a tolerance. It turns "search got worse" from something a user reports weeks later into
something a pull request cannot merge with.

## Baseline

The stored measurement a regression gate compares against. It is committed next to the code, so changing it is a
reviewed decision. A baseline that is raised whenever a number improves keeps the gate tight; one that is never
updated lets quality drift down to the old floor.

## Standard error

How far a measured average is likely to sit from the true one, given the sample size. With 400 questions a difference
of 0.01 in nDCG is within the noise. That is why fathom confirms a close call on the larger profile before changing a
default.

## Query embedding cache

Typing the same query twice should not run the model twice. fathom keeps recent query vectors in memory in each API
process. The model is the slowest step of a search, about 19 milliseconds on the benchmark laptop, so a hit removes
most of the latency.

## Asynchronous indexing

Accepting a write first and computing the expensive derived data later, in another process. The writer gets an answer
at once and the system stays responsive under bursts. In exchange, readers can briefly see a document that is only
half indexed.

## Backlog

Work that has been accepted and not yet done. In fathom it is the number of chunks without a vector, reported as
`pending` by the stats endpoint. A backlog that grows steadily means the indexers cannot keep up with the writes.

## Lease

A claim on a piece of work that expires by itself. An indexer stamps the chunks it takes with a deadline. If the
process is killed mid-task, nobody has to clean up: the deadline passes and another worker picks the same chunks up.

## SKIP LOCKED

A Postgres clause that makes a query pass over rows another transaction has locked instead of waiting for them. It is
the standard building block for a work queue in a table: several workers can each take the next free batch without
blocking one another and without taking the same row twice.

## LISTEN and NOTIFY

Postgres' built-in publish and subscribe. A session listens on a channel, and any transaction can send a notification
that is delivered when it commits. fathom uses it to wake an idle indexer immediately instead of making it poll.

## Advisory lock

A lock in Postgres on a number the application chooses, not on a row or a table. It is a way for cooperating
processes to take turns. fathom's migration holds one, so two deployments starting at once apply the schema one after
the other.

## Idempotent write

An operation that has the same effect whether it is applied once or several times. Sending fathom a document that is
already stored, unchanged, does nothing and says so. A client that is unsure whether its request arrived can simply
send it again.

## Content hash

A digest of a document's title, text, metadata and the way it was cut into chunks, stored next to it. Comparing
digests tells fathom whether an incoming document differs from the stored one without comparing the texts. A second
digest per chunk decides which chunks can keep the vectors they already have.

## Optimistic write-back

Doing slow work without holding a lock, then saving the result only if the input has not changed in the meantime.
fathom's indexer embeds outside any transaction and stores a vector only when the chunk still has the text it read.
Otherwise the vector is discarded.

## API key scope

What a credential is allowed to do. fathom's keys carry a list of collections and the verbs read and write. The demo's
proxy holds a key that can only read one collection, so the worst a leak allows is what the public page already
allows.

## Constant-time comparison

Comparing two secrets in a way whose duration does not depend on where they first differ. An ordinary comparison stops
at the first mismatch, and with enough attempts that timing leaks the secret one byte at a time. Python's
`hmac.compare_digest` is the constant-time one.

## Problem details

A standard JSON shape for HTTP errors (RFC 9457): a type, a title, the status and a human-readable detail, sent as
`application/problem+json`. A client can show the title and detail to a person and branch on the status, without
parsing free text.

## Rate limiting

Refusing requests from a client that sends too many in a period, typically with status 429. A leaky-bucket limiter, as
in nginx' `limit_req`, allows a steady rate plus a small burst. It protects an endpoint that anyone can call from
being monopolised by one caller.

## Reverse proxy

A server that receives requests on behalf of another and forwards them. It is a natural place for work the
application should not repeat: TLS, compression, caching headers, limits. In fathom's demo it also attaches the
credential, so the browser never needs one.

## Content security policy

A response header that tells the browser which sources a page may load scripts, styles, images and connections from.
With `default-src 'self'` and no inline code allowed, an injected script tag does not run even if an escaping bug lets
it into the page.

## Cross-site scripting

An attack in which text supplied by one user is interpreted as markup or script in another user's browser. The usual
cause is inserting a string into a page as HTML. Rendering it as a text node, which is what templating frameworks do
by default, removes the problem.

## Debouncing

Waiting for a short pause in a stream of events before acting on it. A search box that queries on every keystroke
sends five requests for a five-letter word; with a pause of a few hundred milliseconds it sends one. The cost is that
the first result arrives that much later.

## Request cancellation

Abandoning a request whose answer is no longer wanted. When a newer query has been typed, the response to the older
one must not overwrite it, whichever arrives last. In a browser an `AbortSignal` passed to `fetch` does this and also
frees the connection.

## Cold start

The first requests after a process starts, before caches are warm and before the model is loaded into memory. Their
latency is not representative. Benchmarks either discard them or report them separately.

## Tail latency

The slow end of the response-time distribution, usually quoted as the 95th or 99th percentile. An average hides it.
One request in a hundred taking ten times longer is invisible in the mean and is exactly what a user remembers.

## Quantisation

Storing each number of a vector with fewer bits, for example one byte instead of four. The index shrinks and fits in
memory for longer, at some cost in accuracy. fathom stores full-precision vectors, because at its intended size
memory is not yet the constraint.

## ONNX

An open file format for trained models, with runtimes that execute it on ordinary processors without the framework the
model was trained in. fathom runs its embedding model through ONNX Runtime, so the image needs neither PyTorch nor a
graphics card.

## Model drift between versions

Vectors from two different models, or two versions of one, are not comparable: their dimensions mean different things.
Changing the model therefore means computing every stored vector again. Until that finishes, queries embedded by the
new model are being compared with passages embedded by the old one.

## Health and readiness

Two different questions a supervisor asks a process. Health: are you alive, or should you be restarted? Readiness:
can you serve traffic right now? A process that has started and cannot reach its database is alive and not ready.
fathom answers them on `/healthz` and `/readyz`.
