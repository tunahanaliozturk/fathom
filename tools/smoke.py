"""Walks the README quick start against a running `docker compose up` stack, and fails loudly if any step is wrong.

Standard library only. Pass the API key `fathom keys create` printed:

    uv run --no-project python tools/smoke.py fth_...
"""

import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any

BASE = "http://127.0.0.1:8300"
COLLECTION = "smoke"


def call(method: str, path: str, key: str | None, body: Any = None) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"{BASE}{path}", data=data, method=method)  # noqa: S310  # http(s) base only
    request.add_header("Content-Type", "application/json")
    if key:
        request.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"null")


def check(condition: bool, message: str) -> None:
    if not condition:
        print(f"FAIL {message}")
        sys.exit(1)
    print(f"ok   {message.split(':', maxsplit=1)[0]}")


def main() -> None:
    key = sys.argv[1]
    documents = [
        {"id": "eiffel", "title": "Eiffel Tower", "text": "The tower was designed by the engineer Gustave Eiffel."},
        {"id": "louvre", "title": "Louvre", "text": "The Louvre is the most visited museum in the world."},
        {
            "id": "seine",
            "title": "Seine",
            "text": "The Seine flows through the centre of Paris.",
            "metadata": {"kind": "river"},
        },
    ]
    status, body = call("POST", f"/v1/collections/{COLLECTION}/documents", key, {"documents": documents})
    check(status == 202 and len(body) == 3, f"three documents written: {status} {body}")

    deadline = time.monotonic() + 120
    while (stats := call("GET", f"/v1/collections/{COLLECTION}/stats", key)[1])["pending"]:
        check(time.monotonic() < deadline, f"indexer embedded everything in time: {stats}")
        time.sleep(0.5)
    check(stats["chunks"] == 3, f"all chunks embedded: {stats}")

    for mode in ("lexical", "vector", "hybrid"):
        status, body = call(
            "POST", f"/v1/collections/{COLLECTION}/search", key, {"query": "who designed the tower", "mode": mode}
        )
        check(status == 200 and body["hits"][0]["document_id"] == "eiffel", f"{mode} search finds the tower: {body}")

    status, body = call(
        "POST", f"/v1/collections/{COLLECTION}/search", key, {"query": "water in Paris", "filter": {"kind": "river"}}
    )
    check([h["document_id"] for h in body["hits"]] == ["seine"], f"metadata filter: {body}")

    status, _ = call("POST", f"/v1/collections/{COLLECTION}/search", None, {"query": "x"})
    check(status == 401, f"no key is refused: {status}")
    print("smoke passed")


if __name__ == "__main__":
    main()
