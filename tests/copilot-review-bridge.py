#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "copilot_review_bridge",
    ROOT / "tools" / "copilot_review_bridge.py",
)
assert SPEC and SPEC.loader
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def main() -> int:
    assert bridge.requested_ref("REF: main\nCheck it") == "main"
    assert bridge.requested_ref("text\nREF: feature/test-1\nmore") == "feature/test-1"
    assert bridge.requested_ref("no ref here") == "main"

    for bad in ("REF: ../secret", "REF: /main", "REF: main/", "REF: a..b"):
        try:
            bridge.requested_ref(bad)
        except RuntimeError:
            pass
        else:
            raise AssertionError(f"unsafe ref accepted: {bad}")

    assert bridge.author_login({"author": {"login": "citadel-AI-EWS"}}) == "citadel-AI-EWS"
    assert bridge.labels_of({"labels": [{"name": bridge.REVIEW_LABEL}]}) == {bridge.REVIEW_LABEL}

    prompt = bridge.build_prompt(
        {"title": "Audit test", "body": "REF: main\nFind a regression."},
        "0123456789abcdef",
    )
    assert "independent second reviewer" in prompt
    assert "0123456789abcdef" in prompt
    assert "Do not trust README" in prompt
    print("Copilot review bridge policy helpers: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
