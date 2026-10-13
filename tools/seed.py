"""Fills the demo collection the browser console searches, and leaves the web proxy its read key (ADR 8, ADR 9).

It runs once per `docker compose up`, inside the fathom image, as the `seed` service:

1. Reuse the read key in the state directory if the API still accepts it; otherwise create one with
   `fathom keys create` and write it there. The web container mounts the same volume read-only.
2. Send every section of the corpus through the HTTP API with a write key that exists only while this runs. A section
   the API already has comes back `unchanged`, so a second run writes nothing.
3. Delete what an earlier run sent and the corpus no longer contains.
4. Wait until no chunk is waiting for a vector. Only then does this exit 0, and only then does compose start the
   web container, so the first search a person makes already has both retrievers behind it.

Standard library only: the image has no HTTP client beyond it.
"""

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from itertools import batched
from pathlib import Path
from typing import Any

COLLECTION = "demo"
BATCH = 100  # the API's limit for one request

_KEY = re.compile(r"^fth_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$")
_HEADING = re.compile(r"^(#{1,2}) +(.+?)\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")
_TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")
_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")


def corpus_files(root: Path) -> list[Path]:
    """The markdown the demo searches: the top-level documents, docs/ and corpus/. compose.yaml mounts the same set."""
    return [*sorted(root.glob("*.md")), *sorted(root.glob("docs/**/*.md")), *sorted(root.glob("corpus/**/*.md"))]


def sections(markdown: str) -> Iterator[tuple[str, str, str]]:
    """``(h1, h2, body)`` for the text before the first second-level heading, then for each such heading.

    A line starting with ``#`` inside a code fence is a comment in someone's shell example, not a heading.
    """
    h1 = h2 = ""
    body: list[str] = []
    fenced = False
    for line in markdown.splitlines():
        if _FENCE.match(line):
            fenced = not fenced
        heading = None if fenced else _HEADING.match(line)
        if heading is None:
            body.append(line)
        elif len(heading[1]) == 1 and not h1:
            h1 = heading[2]
        else:
            yield h1, h2, "\n".join(body).strip()
            h2, body = heading[2], []
    yield h1, h2, "\n".join(body).strip()


def plain(markdown: str) -> str:
    """The words a reader sees, without the markup around them: what is searched and what a snippet shows.

    Fence markers and table rules go, a link keeps its text, a table row keeps its cells, emphasis and code marks go.
    """
    lines = []
    for raw in markdown.splitlines():
        if _FENCE.match(raw) or _TABLE_RULE.match(raw):
            continue
        line = raw
        while (unlinked := _LINK.sub(r"\1", line)) != line:  # a badge is an image inside a link
            line = unlinked
        if line.lstrip().startswith("|"):
            line = line.strip().strip("|").strip()
        lines.append(line.replace("**", "").replace("`", ""))
    return "\n".join(lines).strip()


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def documents(root: Path) -> list[dict[str, Any]]:
    """One document per section, in the shape the API takes. Ids are stable across runs: file path plus heading."""
    found: dict[str, dict[str, Any]] = {}
    for path in corpus_files(root):
        source = path.relative_to(root).as_posix()
        for h1, raw_h2, raw_body in sections(path.read_text(encoding="utf-8")):
            h2, body = plain(raw_h2), plain(raw_body)
            if not body:
                continue
            name = f"ADR {h1}" if "adr" in path.parts else h1
            base = ":".join(part for part in (_slug(source.removesuffix(".md")), _slug(h2)) if part)
            # Two sections of one file with the same heading: the second and later get a number.
            key = next(k for k in (base, *(f"{base}-{n}" for n in range(2, 1000))) if k not in found)
            found[key] = {
                "id": key,
                "title": f"{name}: {h2}" if h2 else name,
                "text": body,
                # The console shows the section and the document on separate lines, and the file under a result.
                "metadata": {"source": source, "document": name} | ({"section": h2} if h2 else {}),
            }
    return list(found.values())


def call(method: str, url: str, key: str, body: Any = None) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method)  # noqa: S310  # the API's own address
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"null")


def _fathom(*arguments: str) -> str:
    done = subprocess.run(["fathom", *arguments], capture_output=True, text=True, check=False)  # noqa: S603, S607
    if done.returncode != 0:
        sys.exit(f"fathom {' '.join(arguments[:2])} failed: {done.stderr.strip()}")
    return done.stdout


def create_key(scope: str, label: str) -> str:
    printed = _fathom("keys", "create", "--collections", COLLECTION, "--scopes", scope, "--label", label).split()
    if not printed or not _KEY.match(printed[-1]):
        sys.exit("fathom keys create did not print a key")
    return printed[-1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--api", default="http://api:8000")
    parser.add_argument("--corpus", type=Path, default=Path("/corpus"))
    parser.add_argument("--state", type=Path, default=Path("/var/lib/fathom"))
    parser.add_argument("--timeout", type=float, default=600, help="seconds to wait for the indexer")
    args = parser.parse_args()
    base = f"{args.api}/v1/collections/{COLLECTION}"

    corpus = documents(args.corpus)
    if not corpus:
        sys.exit(f"no markdown under {args.corpus}")

    key_file: Path = args.state / "read.key"
    read_key = key_file.read_text(encoding="utf-8").strip() if key_file.exists() else ""
    if not _KEY.match(read_key) or call("GET", f"{base}/stats", read_key)[0] != 200:
        read_key = create_key("read", "web proxy")
        key_file.write_text(read_key + "\n", encoding="utf-8")
        print("created a read key for the web proxy")

    write_key = create_key("write", "seed")
    try:
        unchanged = 0
        for batch in batched(corpus, BATCH, strict=False):
            status, body = call("POST", f"{base}/documents", write_key, {"documents": list(batch)})
            if status != 202:
                sys.exit(f"the API refused a batch: {status} {body}")
            unchanged += sum(1 for written in body if written["unchanged"])
        print(f"{len(corpus)} documents sent: {len(corpus) - unchanged} written, {unchanged} unchanged")

        manifest: Path = args.state / "seeded.json"
        before = set(json.loads(manifest.read_text(encoding="utf-8"))) if manifest.exists() else set()
        current = {document["id"] for document in corpus}
        for stale in sorted(before - current):
            status, _ = call("DELETE", f"{base}/documents/{stale}", write_key)
            print(f"removed {stale}: {status}")
        manifest.write_text(json.dumps(sorted(current)), encoding="utf-8")
    finally:
        _fathom("keys", "revoke", write_key.split("_")[1])

    deadline = time.monotonic() + args.timeout
    while (stats := call("GET", f"{base}/stats", read_key)[1])["pending"]:
        if time.monotonic() > deadline:
            sys.exit(f"the indexer did not finish in {args.timeout:.0f} s: {stats}")
        time.sleep(1)
    print(f"ready: {stats}")


if __name__ == "__main__":
    main()
