#!/usr/bin/env python3
"""Install LM Studio llmster on Windows without executing PowerShell.

The helper follows LM Studio's official installer metadata:
- reads https://lmstudio.ai/install.ps1 as data only;
- downloads the official llmster archive from llmster.lmstudio.ai;
- verifies the published SHA-512;
- extracts safely;
- runs only the fixed llmster.exe bootstrap entry point.

No shell, no PowerShell policy changes, no PATH modification.
"""
from __future__ import annotations

import hashlib
import os
import platform
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

INSTALLER_METADATA_URL = "https://lmstudio.ai/install.ps1"
ALLOWED_METADATA_HOST = "lmstudio.ai"
ALLOWED_ARTIFACT_HOST = "llmster.lmstudio.ai"
MAX_METADATA_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024
VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")
SHA512_RE = re.compile(r"\b([0-9a-fA-F]{128})\b")


def _download_bytes(url: str, max_bytes: int) -> bytes:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https":
        raise RuntimeError("LM Studio download must use HTTPS")
    if parsed.hostname not in {ALLOWED_METADATA_HOST, ALLOWED_ARTIFACT_HOST}:
        raise RuntimeError("LM Studio download host is not allowlisted")
    request = urllib.request.Request(url, headers={"User-Agent": "CITADEL-EWS-LM-Bootstrap/1"})
    with urllib.request.urlopen(request, timeout=60) as response:
        final = urllib.parse.urlsplit(response.geturl())
        if final.scheme != "https" or final.hostname not in {ALLOWED_METADATA_HOST, ALLOWED_ARTIFACT_HOST}:
            raise RuntimeError("LM Studio redirect left the allowlisted hosts")
        data = response.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise RuntimeError("LM Studio download exceeded size limit")
    return data


def _download_file(url: str, path: Path, max_bytes: int) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != ALLOWED_ARTIFACT_HOST:
        raise RuntimeError("LM Studio artifact URL is not allowlisted")
    request = urllib.request.Request(url, headers={"User-Agent": "CITADEL-EWS-LM-Bootstrap/1"})
    total = 0
    with urllib.request.urlopen(request, timeout=120) as response, path.open("wb") as stream:
        final = urllib.parse.urlsplit(response.geturl())
        if final.scheme != "https" or final.hostname != ALLOWED_ARTIFACT_HOST:
            raise RuntimeError("LM Studio artifact redirect left the allowlisted host")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise RuntimeError("LM Studio archive exceeded size limit")
            stream.write(chunk)
    if total < 1024:
        raise RuntimeError("LM Studio archive is unexpectedly small")


def _metadata() -> tuple[str, str, str]:
    text = _download_bytes(INSTALLER_METADATA_URL, MAX_METADATA_BYTES).decode("utf-8", errors="strict")
    fields: dict[str, str] = {}
    for key in ("APP_VERSION", "APP_VARIANT", "ARTIFACT_DOWNLOAD_URL"):
        match = re.search(rf"^[$]{key}\s*=\s*['\"]([^'\"]+)['\"]\s*$", text, re.MULTILINE)
        if not match:
            raise RuntimeError(f"LM Studio installer metadata missing {key}")
        fields[key] = match.group(1).strip()
    version = fields["APP_VERSION"]
    variant = fields["APP_VARIANT"]
    base = fields["ARTIFACT_DOWNLOAD_URL"]
    if not VERSION_RE.fullmatch(version) or not VERSION_RE.fullmatch(variant):
        raise RuntimeError("LM Studio installer metadata is invalid")
    parsed = urllib.parse.urlsplit(base if "://" in base else "https://" + base)
    if parsed.scheme != "https" or parsed.hostname != ALLOWED_ARTIFACT_HOST:
        raise RuntimeError("LM Studio artifact base is not allowlisted")
    return version, variant, f"https://{ALLOWED_ARTIFACT_HOST}/download"


def _arch_token() -> str:
    machine = platform.machine().lower()
    if machine in {"amd64", "x86_64"}:
        return "x64"
    if machine in {"arm64", "aarch64"}:
        return "arm64"
    raise RuntimeError(f"Unsupported Windows architecture: {platform.machine()}")


def _checksum(base: str, release: str) -> str:
    for suffix in (".zip.sha512", ".sha512"):
        try:
            text = _download_bytes(f"{base}/{release}{suffix}", 64 * 1024).decode("ascii", errors="strict")
        except Exception:
            continue
        match = SHA512_RE.search(text)
        if match:
            return match.group(1).lower()
    raise RuntimeError("LM Studio SHA-512 checksum is unavailable")


def _sha512_file(path: Path) -> str:
    digest = hashlib.sha512()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _safe_extract(archive: Path, destination: Path) -> None:
    destination = destination.resolve()
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            target = (destination / member.filename).resolve()
            if destination != target and destination not in target.parents:
                raise RuntimeError("Unsafe path inside LM Studio archive")
        zf.extractall(destination)


def _runtime_home() -> Path:
    raw = os.environ.get("CITADEL_LMSTUDIO_HOME", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if not local:
        raise RuntimeError("LOCALAPPDATA is unavailable")
    return (Path(local) / "CitadelEWS" / "state" / "lmstudio-runtime-home").resolve()


def main() -> int:
    if os.name != "nt":
        raise RuntimeError("This helper is Windows-only")
    home = _runtime_home()
    home.mkdir(parents=True, exist_ok=True)

    version, variant, base = _metadata()
    release = f"{version}-win32-{_arch_token()}.{variant}"
    archive_url = f"{base}/{release}.zip"
    expected = _checksum(base, release)

    with tempfile.TemporaryDirectory(prefix="citadel-lmstudio-") as temp:
        temp_root = Path(temp)
        archive = temp_root / "llmster.zip"
        _download_file(archive_url, archive, MAX_ARCHIVE_BYTES)
        actual = _sha512_file(archive)
        if actual != expected:
            raise RuntimeError("LM Studio archive SHA-512 mismatch")
        extracted = temp_root / "payload"
        extracted.mkdir()
        _safe_extract(archive, extracted)
        bootstrap = extracted / "llmster.exe"
        if not bootstrap.is_file():
            candidates = list(extracted.rglob("llmster.exe"))
            if len(candidates) != 1:
                raise RuntimeError("LM Studio llmster.exe not found in verified archive")
            bootstrap = candidates[0]

        env = os.environ.copy()
        env["HOME"] = str(home)
        env["CITADEL_LMSTUDIO_HOME"] = str(home)
        env["LMS_NO_MODIFY_PATH"] = "1"
        env["LMS_BOOTSTRAP_INSTALL_SH"] = "1"
        result = subprocess.run(
            [str(bootstrap), "bootstrap"],
            env=env,
            capture_output=True,
            text=True,
            timeout=600,
            shell=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "llmster bootstrap failed").strip()
            raise RuntimeError(detail[:800])

    candidates = [home / ".lmstudio" / "bin" / "lms.exe", home / ".lmstudio" / "bin" / "lms"]
    if not any(path.is_file() for path in candidates):
        pointer = home / ".lmstudio-home-pointer"
        if pointer.is_file():
            pointed = Path(pointer.read_text(encoding="utf-8").strip()).expanduser()
            candidates.extend([pointed / "bin" / "lms.exe", pointed / "bin" / "lms"])
    if not any(path.is_file() for path in candidates):
        raise RuntimeError("lms CLI was not found after verified llmster bootstrap")

    print(f"[CITADEL] LM Studio llmster {version} installed and verified.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[CITADEL] LM Studio bootstrap failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
