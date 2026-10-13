"""The demo corpus: how markdown becomes the documents `tools/seed.py` sends, and that the committed corpus fits."""

import re
from pathlib import Path

from tools import seed

REPOSITORY = Path(__file__).resolve().parent.parent.parent

MARKDOWN = """\
# Operations

Opening paragraph.

## Quick start

```sh
# not a heading: a comment in a shell example
docker compose up
```

## Empty

## Quick start

A second section with the same heading.
"""


def test_a_file_becomes_one_document_per_section_that_has_text(tmp_path: Path) -> None:
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "operations.md").write_text(MARKDOWN, encoding="utf-8")

    documents = seed.documents(tmp_path)

    assert [(d["id"], d["title"]) for d in documents] == [
        ("docs-operations", "Operations"),
        ("docs-operations:quick-start", "Operations: Quick start"),
        ("docs-operations:quick-start-2", "Operations: Quick start"),
    ]
    assert documents[1]["text"] == "# not a heading: a comment in a shell example\ndocker compose up"
    assert documents[1]["metadata"] == {
        "source": "docs/operations.md",
        "document": "Operations",
        "section": "Quick start",
    }
    assert documents[0]["metadata"] == {"source": "docs/operations.md", "document": "Operations"}


def test_an_adr_is_titled_as_one(tmp_path: Path) -> None:
    (tmp_path / "docs" / "adr").mkdir(parents=True)
    adr = tmp_path / "docs" / "adr" / "0003-fusion.md"
    adr.write_text("# 3. Fusion\n\n## Decision\n\nRanks.\n", encoding="utf-8")

    assert [d["title"] for d in seed.documents(tmp_path)] == ["ADR 3. Fusion: Decision"]


def test_markup_is_removed_and_the_words_are_kept() -> None:
    markdown = (
        "[![ci](https://example.test/badge.svg)](https://example.test/ci)\n"
        "See **[ADR 2](docs/adr/0002.md)** and `ts_rank`.\n"
        "| mode | p50 |\n"
        "|---|---:|\n"
        "| hybrid | 65 ms |\n"
    )

    assert seed.plain(markdown) == "ci\nSee ADR 2 and ts_rank.\nmode | p50\nhybrid | 65 ms"


def test_the_committed_corpus_is_something_the_api_accepts() -> None:
    # The same rules as DocumentIn and DocumentBatch in fathom.api, restated so this stays a unit test of the tool.
    documents = seed.documents(REPOSITORY)
    ids = [d["id"] for d in documents]

    assert len(documents) > 100
    assert len(set(ids)) == len(ids)
    assert all(re.fullmatch(r"[A-Za-z0-9._:@-]{1,256}", i) for i in ids)
    assert all(d["text"] and len(d["title"]) <= 1000 for d in documents)
    assert {d["metadata"]["source"] for d in documents} >= {"README.md", "corpus/glossary.md", "docs/operations.md"}
