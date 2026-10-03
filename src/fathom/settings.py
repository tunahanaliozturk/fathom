"""Configuration, read from ``FATHOM_*`` environment variables. docs/operations.md has the full table."""

from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FATHOM_", extra="ignore")

    database_url: SecretStr
    pool_size: int = Field(default=10, ge=3)

    embedding_model: str = "BAAI/bge-small-en-v1.5"
    model_cache_dir: Path | None = None
    embedding_threads: int | None = Field(default=None, ge=1)

    chunk_max_words: int = Field(default=180, ge=20, le=2000)
    chunk_overlap_sentences: int = Field(default=1, ge=0, le=5)

    candidates: int = Field(default=50, ge=10, le=500)
    ef_search: int = Field(default=100, ge=10, le=1000)
    rrf_k: int = Field(default=10, ge=0)

    indexer_batch: int = Field(default=64, ge=1, le=1024)
    indexer_idle_wait_seconds: float = Field(default=5, gt=0)

    key_cache_seconds: float = Field(default=10, ge=0)
    max_payload_bytes: int = Field(default=4 * 1024 * 1024, ge=4096)

    otlp_endpoint: str | None = None
    log_level: str = "INFO"
