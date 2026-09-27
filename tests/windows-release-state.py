#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "agent" / "windows" / "release_state.py"


def load_module():
    spec = importlib.util.spec_from_file_location("citadel_windows_release_state_test", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load release_state.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expect_error(fn, code: str) -> None:
    try:
        fn()
    except Exception as error:
        assert str(error) == code, (code, type(error).__name__, str(error))
    else:
        raise AssertionError(f"expected {code}")


def make_state(mod, *, generation: int, current: str, previous: str | None = None, rollbackable: bool = False):
    return mod.ReleaseState(
        generation=generation,
        min_allowed_generation=1,
        current=current,
        previous=previous,
        previous_rollbackable=rollbackable,
        state_schema=1,
        committed_at=f"2026-09-27T20:00:{generation:02d}Z",
    )


def main() -> int:
    mod = load_module()

    good_ids = [
        "0.3.21-a1b2c3",
        "release_7",
        "A.B-C_D",
    ]
    for value in good_ids:
        assert mod.validate_release_id(value) == value

    for bad in [
        "",
        ".",
        "..",
        "../evil",
        "..\\evil",
        "sub/release",
        "sub\\release",
        "C:evil",
        "\\\\server\\share",
        "with space",
        "x" * 129,
    ]:
        expect_error(lambda bad=bad: mod.validate_release_id(bad), "invalid_release_id")

    with tempfile.TemporaryDirectory(prefix="citadel-release-state-") as tmp:
        root = Path(tmp)
        releases = root / "releases"
        releases.mkdir()

        safe = mod.release_root(releases, "0.3.21-a1b2c3")
        assert safe.parent == releases.resolve()
        expect_error(lambda: mod.release_root(releases, "../escape"), "invalid_release_id")

        state_path = root / "state" / "release-state.json"
        first = make_state(mod, generation=1, current="0.3.20-old")
        mod.atomic_commit_release_state(state_path, first)
        assert mod.load_release_state(state_path) == first

        second = make_state(
            mod,
            generation=2,
            current="0.3.21-new",
            previous="0.3.20-old",
            rollbackable=True,
        )
        mod.atomic_commit_release_state(state_path, second)
        loaded = mod.load_release_state(state_path)
        assert loaded == second
        assert loaded.current == "0.3.21-new"
        assert loaded.previous == "0.3.20-old"

        # A stale writer can never move the committed generation backwards or
        # rewrite the same generation with a different current/previous pair.
        expect_error(
            lambda: mod.atomic_commit_release_state(
                state_path,
                make_state(mod, generation=2, current="0.3.21-other", previous="0.3.20-old", rollbackable=True),
            ),
            "release_generation_not_monotonic",
        )
        expect_error(
            lambda: mod.atomic_commit_release_state(
                state_path,
                make_state(mod, generation=1, current="0.3.20-old"),
            ),
            "release_generation_not_monotonic",
        )

        duplicate = make_state(
            mod,
            generation=3,
            current="0.3.21-new",
            previous="0.3.21-new",
            rollbackable=True,
        )
        expect_error(lambda: mod.validate_release_state(duplicate), "duplicate_current_previous_release")

        missing_previous = make_state(
            mod,
            generation=3,
            current="0.3.22-next",
            previous=None,
            rollbackable=True,
        )
        expect_error(lambda: mod.validate_release_state(missing_previous), "rollbackable_previous_missing")

        # A damaged pointer is never guessed around by this library.
        corrupt = root / "state" / "corrupt.json"
        corrupt.write_text("{", encoding="utf-8")
        expect_error(lambda: mod.load_release_state(corrupt), "release_state_corrupt")
        empty = root / "state" / "empty.json"
        empty.write_bytes(b"")
        expect_error(lambda: mod.load_release_state(empty), "release_state_empty")

        # The committed file is one canonical blob, not two independently
        # mutable current/previous pointer files.
        raw = json.loads(state_path.read_text(encoding="utf-8"))
        assert raw["current"] == "0.3.21-new"
        assert raw["previous"] == "0.3.20-old"
        assert raw["generation"] == 2
        assert raw["schema"] == 1
        assert raw["layout"] == "versioned-v1"

        leftovers = list(state_path.parent.glob("release-state.json.*.tmp"))
        assert leftovers == [], leftovers

    print(f"Windows versioned release-state foundation: PASS ({os.name})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
