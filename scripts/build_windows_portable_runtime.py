#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

PYTHON_VERSION = "3.13.15"
PYTHON_TAG = "313"
RUNTIMES = {
    "amd64": {
        "platform": "win_amd64",
        "archive": f"python-{PYTHON_VERSION}-embed-amd64.zip",
        "sha256": "d1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf",
        "requirements": "requirements.txt",
    },
    "win32": {
        "platform": "win32",
        "archive": f"python-{PYTHON_VERSION}-embed-win32.zip",
        "sha256": "3f5506367943d16dffa89f0ea140ebf04481a80611eb119e76e95aea8c79f5ce",
        "requirements": "requirements-win32.txt",
    },
}
BASE_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def download(url: str, destination: Path, expected_sha256: str) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "CITADEL-EWS-build/1"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)
    if sha256_file(destination) != expected_sha256:
        raise RuntimeError(f"hash mismatch for {url}")


def install_wheel(wheel: Path, site_packages: Path) -> None:
    with zipfile.ZipFile(wheel) as archive:
        for member in archive.infolist():
            if member.is_dir():
                continue
            rel = PurePosixPath(member.filename)
            parts = rel.parts
            target_rel = rel
            remapped = False
            for marker in ("purelib", "platlib"):
                for index, part in enumerate(parts):
                    if part.endswith(".data") and index + 1 < len(parts) and parts[index + 1] == marker:
                        target_rel = PurePosixPath(*parts[index + 2 :])
                        remapped = True
                        break
                if remapped:
                    break
            if any(part.endswith(".data") for part in parts) and not remapped:
                continue
            if not target_rel.parts:
                continue
            destination = site_packages.joinpath(*target_rel.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)


def patch_pth(runtime_root: Path) -> None:
    pth = runtime_root / f"python{PYTHON_TAG}._pth"
    if not pth.is_file():
        raise RuntimeError(f"embedded Python path file missing: {pth.name}")
    lines = [line.rstrip("\r\n") for line in pth.read_text(encoding="utf-8").splitlines()]
    out = [line for line in lines if line.strip() and line.strip() != "#import site"]
    # The runtime is used both directly inside the release ZIP
    # (python_runtime/<arch>/python.exe) and after installation
    # (release/python_runtime/python.exe). These two package-owned parent paths
    # let the isolated runtime import the hash-verified agent modules without
    # consulting a system Python or arbitrary PYTHONPATH.
    for line in (
        f"python{PYTHON_TAG}.zip",
        ".",
        r"Lib\site-packages",
        "..",
        r"..\..",
        "import site",
    ):
        if line not in out:
            out.append(line)
    pth.write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")


def build_runtime(root: Path, arch: str, repository_root: Path) -> Path:
    cfg = RUNTIMES[arch]
    target = root / arch
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    with tempfile.TemporaryDirectory(prefix="citadel-python-runtime-") as temp_dir:
        temp = Path(temp_dir)
        archive = temp / str(cfg["archive"])
        download(f"{BASE_URL}/{cfg['archive']}", archive, str(cfg["sha256"]))
        with zipfile.ZipFile(archive) as package:
            package.extractall(target)
        patch_pth(target)

        wheels = temp / "wheels"
        wheels.mkdir()
        requirements = repository_root / "agent" / str(cfg["requirements"])
        subprocess.run(
            [
                sys.executable, "-m", "pip", "download",
                "--disable-pip-version-check",
                "--only-binary=:all:",
                "--platform", str(cfg["platform"]),
                "--python-version", PYTHON_TAG,
                "--implementation", "cp",
                "--abi", f"cp{PYTHON_TAG}",
                "--abi", "abi3",
                "--requirement", str(requirements),
                "--dest", str(wheels),
            ],
            check=True,
        )
        site_packages = target / "Lib" / "site-packages"
        site_packages.mkdir(parents=True, exist_ok=True)
        wheel_names = []
        for wheel in sorted(wheels.glob("*.whl")):
            wheel_names.append(wheel.name)
            install_wheel(wheel, site_packages)

    metadata = {
        "schema": "citadel.windows-portable-python.v1",
        "python_version": PYTHON_VERSION,
        "architecture": arch,
        "source_url": f"{BASE_URL}/{cfg['archive']}",
        "source_sha256": cfg["sha256"],
        "dependency_wheels": wheel_names,
    }
    (target / "CITADEL_RUNTIME.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    files = sorted(
        path for path in target.rglob("*")
        if path.is_file() and path.name != "SHA256SUMS.txt"
    )
    manifest = "".join(
        f"{sha256_file(path)}  {path.relative_to(target).as_posix()}\n"
        for path in files
    )
    (target / "SHA256SUMS.txt").write_text(manifest, encoding="utf-8", newline="\n")
    return target


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(".portable/windows"))
    parser.add_argument("--arch", action="append", choices=sorted(RUNTIMES), dest="architectures")
    args = parser.parse_args()
    repository_root = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    for arch in args.architectures or ["amd64", "win32"]:
        built = build_runtime(output, arch, repository_root)
        print(f"built {arch}: {built}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
