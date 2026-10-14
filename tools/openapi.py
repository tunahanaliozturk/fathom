"""Writes the API's OpenAPI document to docs/openapi.json. It builds the routes only, so it needs no database.

    uv run python tools/openapi.py

The file is committed, and the browser client's types are generated from it (web/src/shared/api/schema.d.ts). CI runs
this again and fails on any difference, so a change to a request or a response cannot land without the file, the
generated types and the client's type-check all seeing it (ADR 10).
"""

import json
import sys
from pathlib import Path

from fathom.api import build_app
from fathom.settings import Settings

DEFAULT = Path(__file__).resolve().parent.parent / "docs" / "openapi.json"


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    limit = Settings.model_fields["max_payload_bytes"].default
    document = build_app(limit).openapi()
    target.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
