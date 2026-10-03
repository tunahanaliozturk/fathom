# 6. A small ONNX model on the CPU

## Context

The vector retriever needs a text embedding model. The options run from hosted APIs (OpenAI, Cohere, Voyage) through
local PyTorch models to ONNX exports run by onnxruntime.

## Decision

`BAAI/bge-small-en-v1.5` (MIT licence, 384 dimensions), through fastembed and onnxruntime, on the CPU. The model is baked
into the container image, so a running service never reaches the network. Queries get bge's instruction prefix and
passages do not, as the model was trained.

## Consequences

- No API key, no per-token bill, no data leaving the machine, no GPU, no PyTorch (an image about a gigabyte smaller).
- It is slow for long passages. Measured on the evaluation corpus (133 tokens per paragraph on average): about 9
  paragraphs a second in batches of 64 as they came, and 18 a second once each batch was sorted by length so that a short
  paragraph is not padded to the length of a long one (`embedding.in_length_order`). That sort was the cheapest doubling
  available. The search path embeds one short query, which takes a few milliseconds.
- English only, and a small model. A bigger or multilingual one is a configuration change (`FATHOM_EMBEDDING_MODEL`),
  provided it produces 384-dimensional vectors; a different width needs a migration, and the indexer refuses to start
  with a mismatch.
- The CI relevance gate runs the real model, not a stand-in, so a model change is measured like any other.
