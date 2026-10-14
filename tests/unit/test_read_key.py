"""`web/read-key.sh` writes the proxy's key into nginx's configuration, so what it accepts is a security boundary.

The script runs under the image's busybox `sh`; here it runs under whatever `sh` the machine has, with the two paths
it normally hard-codes passed as arguments.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent.parent / "web" / "read-key.sh"
KEY = "fth_0123456789abcdef_" + "A-b_" * 10 + "xyz"
INJECTED = '"; add_header X-Injected "by the key file" always; set $x "'

pytestmark = pytest.mark.skipif(shutil.which("sh") is None, reason="needs a POSIX shell")


def run(tmp_path: Path, content: bytes | None) -> tuple[int, str, Path]:
    key_file, conf = tmp_path / "read.key", tmp_path / "fathom-key.conf"
    if content is not None:
        key_file.write_bytes(content)
    done = subprocess.run(  # noqa: S603  # the repository's own script, with paths this test made
        [shutil.which("sh") or "sh", SCRIPT.as_posix(), key_file.as_posix(), conf.as_posix()],
        capture_output=True,
        text=True,
        check=False,
    )
    return done.returncode, done.stderr, conf


@pytest.mark.parametrize("ending", ["\n", ""])
def test_one_key_becomes_one_line_of_configuration(tmp_path: Path, ending: str) -> None:
    code, _, conf = run(tmp_path, (KEY + ending).encode())

    assert code == 0
    assert conf.read_text(encoding="utf-8") == f'proxy_set_header Authorization "Bearer {KEY}";\n'


def test_a_good_first_line_does_not_let_a_second_line_into_the_configuration(tmp_path: Path) -> None:
    # nginx accepts the result of this unvalidated: the quote closes the header value and a directive follows.
    code, said, conf = run(tmp_path, f"{KEY}\n{INJECTED}\n".encode())

    assert code == 1
    assert "does not hold an API key" in said
    assert not conf.exists()


@pytest.mark.parametrize(
    "content",
    [
        f"{KEY}\r\n",
        f"{KEY}\n\n",
        f"{KEY}\n{KEY}\n",
        f"{KEY} trailing\n",
        f" {KEY}\n",
        f"\n{KEY}\n",
        f'{KEY}";\n',
        f"{KEY[:-1]}\n",
        f"{KEY}x\n",
        "fth_not-a-key\n",
        "",
        "\n",
    ],
    ids=[
        "carriage return",
        "blank line after",
        "two keys",
        "words after the key",
        "space before",
        "blank line before",
        "quote and semicolon",
        "one character short",
        "one character long",
        "wrong shape",
        "empty",
        "only a newline",
    ],
)
def test_anything_but_exactly_one_key_is_refused(tmp_path: Path, content: str) -> None:
    code, said, conf = run(tmp_path, content.encode())

    assert code == 1
    assert "does not hold an API key" in said
    assert not conf.exists()


def test_a_missing_key_file_is_named_as_the_problem(tmp_path: Path) -> None:
    code, said, conf = run(tmp_path, None)

    assert code == 1
    assert "is missing" in said
    assert not conf.exists()
