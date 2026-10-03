create extension if not exists vector;

-- A document is what a client sends; chunks are what gets searched. The client's id is the key, within a collection.
create table fathom_documents (
    collection   text        not null check (collection ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    id           text        not null check (length(id) between 1 and 256),
    title        text        not null default '',
    metadata     jsonb       not null default '{}' check (jsonb_typeof(metadata) = 'object'),
    content_hash text        not null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    primary key (collection, id)
);

create table fathom_chunks (
    id           bigint      generated always as identity primary key,
    collection   text        not null,
    document_id  text        not null,
    ordinal      integer     not null,
    title        text        not null,
    text         text        not null,
    content_hash text        not null,
    -- Copied from the document so that filtering never needs a join in front of an index scan.
    metadata     jsonb       not null,
    -- The title counts more than the body. 'english' stems and drops stop words; a collection in another language
    -- would need its own configuration, which is a known limitation (docs/operations.md).
    tsv          tsvector    generated always as (
                     setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', text), 'B')
                 ) stored,
    -- NULL until the indexer has embedded it. Search skips these; the pending index below finds them.
    embedding    vector(384),
    -- Set while an indexer is embedding this chunk, so others leave it alone without anyone holding a lock meanwhile.
    claimed_until timestamptz,
    foreign key (collection, document_id) references fathom_documents (collection, id) on delete cascade,
    -- Checked at commit: replacing a document's chunks deletes and inserts in one statement, and an immediate check
    -- would trip over an old row the statement has not deleted yet (two identical paragraphs make that happen).
    unique (collection, document_id, ordinal) deferrable initially deferred
);

create index fathom_chunks_tsv on fathom_chunks using gin (tsv);
create index fathom_chunks_embedding on fathom_chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index fathom_chunks_pending on fathom_chunks (id) where embedding is null;
create index fathom_chunks_metadata on fathom_chunks using gin (metadata jsonb_path_ops);
create index fathom_chunks_collection on fathom_chunks (collection);

-- API keys. Only a SHA-256 of the secret is stored: the secret is 32 random bytes, so a slow password hash would buy
-- nothing, and a leaked table still does not let anyone in.
create table fathom_api_keys (
    id          text        primary key,
    secret_hash bytea       not null,
    collections text[]      not null,
    scopes      text[]      not null check (scopes <@ array['read', 'write']::text[] and cardinality(scopes) > 0),
    label       text        not null default '',
    created_at  timestamptz not null default now(),
    revoked_at  timestamptz
);
