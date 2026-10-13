"""What `tools/seed.py` does to a stack when it runs, with the API and the `fathom` command replaced by a recorder.

ADR 8 and ADR 9 state these as facts (the read key is kept, the write key is revoked, sections that left the corpus are
deleted), so each has a test that fails if the script stops doing it.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from tools import seed

BASE = "http://api.test/v1/collections/demo"


class Stack:
    """Stands in for the API and for `fathom keys`: records what was asked and answers as a healthy stack would."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, str]] = []
        self.commands: list[tuple[str, ...]] = []
        self.active: set[str] = set()
        self.refuse_documents = False
        self.delete_status = 204

    def call(self, method: str, url: str, key: str, body: Any = None) -> tuple[int, Any]:
        assert url.startswith(BASE)
        path = url.removeprefix(BASE)
        self.requests.append((method, path, key))
        if key not in self.active:
            return 401, {"title": "Unauthorised"}
        match method, path:
            case "GET", "/stats":
                return 200, {"documents": 1, "chunks": 1, "pending": 0}
            case "POST", "/documents":
                if self.refuse_documents:
                    return 422, {"detail": "refused"}
                return 202, [{"id": d["id"], "unchanged": False} for d in body["documents"]]
            case "POST", "/search":
                return 200, {"hits": [{"document_id": "docs-a:one"}]}
            case "DELETE", _:
                return self.delete_status, None
        raise AssertionError(f"the seed step asked for something unexpected: {method} {path}")

    def fathom(self, *arguments: str) -> str:
        self.commands.append(arguments)
        match arguments:
            case ("keys", "create", *_):
                key = f"fth_{len(self.commands):016x}_{'k' * 43}"
                self.active.add(key)
                return f"{key}\n"
            case ("keys", "revoke", key_id):
                self.active = {key for key in self.active if key.split("_")[1] != key_id}
                return ""
        raise AssertionError(f"the seed step ran an unexpected command: {arguments}")

    def created(self, scope: str) -> list[tuple[str, ...]]:
        return [c for c in self.commands if c[:2] == ("keys", "create") and c[c.index("--scopes") + 1] == scope]

    def deleted(self) -> list[str]:
        return [path.removeprefix("/documents/") for method, path, _ in self.requests if method == "DELETE"]


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Stack:
    fake = Stack()
    monkeypatch.setattr(seed, "call", fake.call)
    monkeypatch.setattr(seed, "_fathom", fake.fathom)
    return fake


@pytest.fixture
def corpus(tmp_path: Path) -> Path:
    root = tmp_path / "corpus"
    (root / "docs").mkdir(parents=True)
    (root / "docs" / "a.md").write_text("# A\n\n## One\n\nThe only section.\n", encoding="utf-8")
    return root


@pytest.fixture
def state(tmp_path: Path) -> Path:
    directory = tmp_path / "state"
    directory.mkdir()
    return directory


def run(corpus: Path, state: Path) -> None:
    seed.main(["--api", "http://api.test", "--corpus", str(corpus), "--state", str(state), "--timeout", "5"])


def manifest(state: Path) -> list[str]:
    return list(json.loads((state / "seeded.json").read_text(encoding="utf-8")))


def test_a_section_that_left_the_corpus_is_deleted_and_the_rest_are_left_alone(
    stack: Stack, corpus: Path, state: Path
) -> None:
    (state / "seeded.json").write_text(json.dumps(["docs-a:one", "docs-old:gone"]), encoding="utf-8")

    run(corpus, state)

    assert stack.deleted() == ["docs-old:gone"]
    assert manifest(state) == ["docs-a:one"]


def test_a_second_run_keeps_the_read_key_the_first_one_made(
    stack: Stack, corpus: Path, state: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    run(corpus, state)
    first_key = (state / "read.key").read_text(encoding="utf-8")
    assert "created a read key" in capsys.readouterr().out

    run(corpus, state)

    assert len(stack.created("read")) == 1
    assert (state / "read.key").read_text(encoding="utf-8") == first_key
    assert "created a read key" not in capsys.readouterr().out


def test_a_read_key_the_api_no_longer_accepts_is_replaced(stack: Stack, corpus: Path, state: Path) -> None:
    run(corpus, state)
    first_key = (state / "read.key").read_text(encoding="utf-8").strip()
    stack.active.discard(first_key)  # revoked by hand, or the database was replaced

    run(corpus, state)

    second_key = (state / "read.key").read_text(encoding="utf-8").strip()
    assert second_key != first_key
    assert second_key in stack.active
    assert len(stack.created("read")) == 2


def test_the_write_key_is_revoked_when_the_run_succeeds(stack: Stack, corpus: Path, state: Path) -> None:
    run(corpus, state)

    read_key = (state / "read.key").read_text(encoding="utf-8").strip()
    assert len(stack.created("write")) == 1
    # Of the two keys made, only the proxy's is still accepted.
    assert stack.active == {read_key}
    assert stack.commands[-1][:2] == ("keys", "revoke")


def test_the_write_key_is_revoked_when_the_api_refuses_a_batch(stack: Stack, corpus: Path, state: Path) -> None:
    stack.refuse_documents = True

    with pytest.raises(SystemExit, match="the API refused a batch: 422"):
        run(corpus, state)

    read_key = (state / "read.key").read_text(encoding="utf-8").strip()
    assert len(stack.created("write")) == 1
    assert stack.active == {read_key}


def test_a_manifest_that_cannot_be_read_is_treated_as_empty_and_said_so(
    stack: Stack, corpus: Path, state: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # What a container stopped in the middle of a write leaves behind.
    (state / "seeded.json").write_text('["docs-a:one", "docs-ol', encoding="utf-8")

    run(corpus, state)

    assert "seeded.json could not be read" in capsys.readouterr().out
    assert stack.deleted() == []
    assert manifest(state) == ["docs-a:one"]


@pytest.mark.parametrize("content", ['{"docs-a:one": true}', '["docs-a:one", 7]', "null"])
def test_a_manifest_of_the_wrong_shape_is_treated_as_empty(
    stack: Stack, corpus: Path, state: Path, content: str
) -> None:
    (state / "seeded.json").write_text(content, encoding="utf-8")

    run(corpus, state)

    assert stack.deleted() == []
    assert manifest(state) == ["docs-a:one"]


def test_a_delete_that_failed_is_tried_again_on_the_next_run(stack: Stack, corpus: Path, state: Path) -> None:
    (state / "seeded.json").write_text(json.dumps(["docs-a:one", "docs-old:gone"]), encoding="utf-8")
    stack.delete_status = 503

    run(corpus, state)

    # Still listed: forgetting it now would leave the section in the collection for good.
    assert manifest(state) == ["docs-a:one", "docs-old:gone"]

    stack.delete_status = 204
    run(corpus, state)

    assert stack.deleted() == ["docs-old:gone", "docs-old:gone"]
    assert manifest(state) == ["docs-a:one"]


def test_a_section_that_is_already_gone_is_forgotten(stack: Stack, corpus: Path, state: Path) -> None:
    (state / "seeded.json").write_text(json.dumps(["docs-a:one", "docs-old:gone"]), encoding="utf-8")
    stack.delete_status = 404

    run(corpus, state)

    assert manifest(state) == ["docs-a:one"]


def test_the_manifest_is_replaced_whole_or_not_at_all(
    stack: Stack, corpus: Path, state: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = json.dumps(["docs-a:one", "docs-old:gone"])
    (state / "seeded.json").write_text(before, encoding="utf-8")

    def interrupted(self: Path, target: Path) -> Path:
        raise OSError("the container was stopped")

    monkeypatch.setattr(Path, "replace", interrupted)

    with pytest.raises(OSError, match="the container was stopped"):
        run(corpus, state)

    # The new list never took the old one's place, so the old one is still a list the next run can read.
    assert (state / "seeded.json").read_text(encoding="utf-8") == before
