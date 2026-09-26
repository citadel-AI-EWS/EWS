#!/usr/bin/env python3
"""Read-only GitHub -> Copilot CLI review bridge for CITADEL/EWS.

The bridge watches explicitly labelled issues created by an allowed repository
owner, checks out the requested repository ref in a dedicated clean clone,
runs GitHub Copilot CLI in read-only programmatic mode, and posts the report
back to the same issue.

It deliberately does not grant shell or write tools to Copilot.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

BRIDGE_VERSION = "0.1.0"
DEFAULT_REPOSITORY = "citadel-AI-EWS/EWS"
REVIEW_LABEL = "citadel-copilot-review"
RUNNING_LABEL = "citadel-copilot-running"
DONE_LABEL = "citadel-copilot-done"
FAILED_LABEL = "citadel-copilot-failed"
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$")


def run(args: list[str], *, cwd: Path | None = None, timeout: int = 120, check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
        timeout=timeout,
        shell=False,
    )
    if check and completed.returncode != 0:
        stderr = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"{args[0]} failed ({completed.returncode}): {stderr[:2000]}")
    return completed


def gh_json(args: list[str], *, timeout: int = 120) -> Any:
    completed = run(["gh", *args], timeout=timeout)
    return json.loads(completed.stdout or "null")


def labels_of(issue: dict[str, Any]) -> set[str]:
    rows = issue.get("labels") or []
    return {str(row.get("name") or "") for row in rows if isinstance(row, dict)}


def author_login(issue: dict[str, Any]) -> str:
    author = issue.get("author")
    if isinstance(author, dict):
        return str(author.get("login") or "")
    return ""


def requested_ref(body: str) -> str:
    for line in body.splitlines()[:20]:
        if line.upper().startswith("REF:"):
            ref = line.split(":", 1)[1].strip()
            if not REF_RE.fullmatch(ref) or ".." in ref or ref.startswith("/") or ref.endswith("/"):
                raise RuntimeError("invalid REF")
            return ref
    return "main"


def prepare_ref(repo_root: Path, ref: str) -> str:
    status = run(["git", "status", "--porcelain"], cwd=repo_root).stdout.strip()
    if status:
        raise RuntimeError("review checkout is not clean; refusing to overwrite local work")
    run(["git", "fetch", "--prune", "origin"], cwd=repo_root, timeout=300)
    candidates = [f"origin/{ref}", ref]
    for candidate in candidates:
        resolved = run(
            ["git", "rev-parse", "--verify", f"{candidate}^{{commit}}"],
            cwd=repo_root,
            check=False,
        )
        if resolved.returncode == 0:
            sha = resolved.stdout.strip()
            run(["git", "checkout", "--detach", sha], cwd=repo_root, timeout=120)
            return sha
    raise RuntimeError(f"repository ref not found: {ref}")


def build_prompt(issue: dict[str, Any], sha: str) -> str:
    title = str(issue.get("title") or "").strip()
    body = str(issue.get("body") or "").strip()
    return f"""You are CITADEL/EWS's independent second reviewer.

Repository commit checked out for this review: {sha}

Review task:
TITLE: {title}

{body}

Rules:
- Work read-only. Do not request permission to modify files.
- Inspect the actual checked-out code before conclusions.
- Do not trust README, comments, UI labels, ChatGPT claims, or previous Copilot claims without code evidence.
- Before calling anything MISSING, search for the exact file/function/symbol and close variants.
- Separate: code exists / automated test proves behavior / live E2E proves behavior.
- Cite file paths and function/symbol names.
- If evidence is insufficient, use NOT VERIFIED.
- Try to falsify the proposed implementation and identify regressions.
- Do not expose credentials or secrets.

Return:
SUMMARY
CONFIRMED
PROBLEMS
NOT VERIFIED
TEST GAPS
QUESTIONS FOR CHATGPT
"""


def copilot_review(repo_root: Path, prompt: str, timeout: int) -> str:
    completed = run(
        [
            "copilot",
            "-p",
            prompt,
            "-s",
            "--no-ask-user",
            "--available-tools=view,grep,glob,bash",
            "--allow-tool=read",
            "--allow-tool=shell(git status)",
            "--allow-tool=shell(git diff:*)",
            "--allow-tool=shell(git show:*)",
            "--allow-tool=shell(git log:*)",
            "--allow-tool=shell(git rev-parse:*)",
            "--deny-tool=write",
            "--deny-tool=shell(git push)",
        ],
        cwd=repo_root,
        timeout=timeout,
    )
    text = (completed.stdout or "").strip()
    if not text:
        raise RuntimeError("Copilot returned an empty review")
    return text[:55000]


def edit_labels(repository: str, number: int, *, add: str | None = None, remove: str | None = None) -> None:
    args = ["issue", "edit", str(number), "--repo", repository]
    if add:
        args.extend(["--add-label", add])
    if remove:
        args.extend(["--remove-label", remove])
    run(["gh", *args], timeout=120)


def post_comment(repository: str, number: int, text: str) -> None:
    body = f"<!-- citadel-copilot-bridge:{BRIDGE_VERSION} -->\n{text}"
    run(["gh", "issue", "comment", str(number), "--repo", repository, "--body", body], timeout=120)


def ensure_labels(repository: str) -> None:
    labels = [
        (REVIEW_LABEL, "1D76DB", "Queued for the local Copilot reviewer bridge"),
        (RUNNING_LABEL, "FBCA04", "Currently being reviewed by Copilot CLI"),
        (DONE_LABEL, "0E8A16", "Copilot review completed"),
        (FAILED_LABEL, "D1242F", "Copilot review bridge failed"),
    ]
    for name, color, description in labels:
        run([
            "gh", "label", "create", name, "--repo", repository,
            "--color", color, "--description", description, "--force",
        ], timeout=120)


def list_tasks(repository: str) -> list[dict[str, Any]]:
    value = gh_json([
        "issue", "list",
        "--repo", repository,
        "--state", "open",
        "--label", REVIEW_LABEL,
        "--limit", "20",
        "--json", "number,title,body,author,labels",
    ])
    return value if isinstance(value, list) else []


def process_issue(repository: str, repo_root: Path, issue: dict[str, Any], allowed_authors: set[str], timeout: int) -> None:
    number = int(issue["number"])
    author = author_login(issue)
    if author not in allowed_authors:
        post_comment(repository, number, f"Bridge refused this task: issuer {author!r} is not allowlisted.")
        edit_labels(repository, number, add=FAILED_LABEL, remove=REVIEW_LABEL)
        return

    edit_labels(repository, number, add=RUNNING_LABEL, remove=REVIEW_LABEL)
    try:
        ref = requested_ref(str(issue.get("body") or ""))
        sha = prepare_ref(repo_root, ref)
        report = copilot_review(repo_root, build_prompt(issue, sha), timeout)
        post_comment(repository, number, f"## Copilot independent review\n\nREF: `{ref}`\nCOMMIT: `{sha}`\n\n{report}")
    except Exception as error:
        safe = str(error).replace("\r", " ").replace("\n", " ")[:3000]
        post_comment(repository, number, f"## Copilot bridge failure\n\n`{safe}`")
        edit_labels(repository, number, add=FAILED_LABEL, remove=RUNNING_LABEL)
        return

    edit_labels(repository, number, add=DONE_LABEL, remove=RUNNING_LABEL)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", default=DEFAULT_REPOSITORY)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--allowed-author", action="append", default=[])
    parser.add_argument("--poll-seconds", type=int, default=20)
    parser.add_argument("--copilot-timeout", type=int, default=1800)
    parser.add_argument("--once", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    if not (repo_root / ".git").exists():
        raise SystemExit(f"Not a Git checkout: {repo_root}")

    allowed = set(args.allowed_author or ["citadel-AI-EWS"])
    run(["gh", "auth", "status"], timeout=60)
    run(["copilot", "--version"], timeout=60)
    run(["git", "--version"], timeout=60)
    ensure_labels(args.repository)

    while True:
        for issue in list_tasks(args.repository):
            if DONE_LABEL in labels_of(issue) or RUNNING_LABEL in labels_of(issue):
                continue
            process_issue(args.repository, repo_root, issue, allowed, args.copilot_timeout)
        if args.once:
            return 0
        time.sleep(max(10, min(300, args.poll_seconds)))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
