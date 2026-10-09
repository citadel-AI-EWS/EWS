"""The real Linux kernel must reject a CLI held open for writing, then recover."""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

if sys.platform != "linux":
    print("Linux installer ETXTBSY test: Linux only")
    raise SystemExit(0)

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="citadel-lms-busy-") as directory:
    tmp = Path(directory)
    home = tmp / "home"
    binary = home / ".lmstudio" / "bin" / "lms"
    binary.parent.mkdir(parents=True)
    marker = tmp / "writer-ready"
    ready = tmp / "server-ready"
    holder = tmp / "holder.py"
    holder.write_text("import sys,time\nfrom pathlib import Path\n"
                      "with open(sys.argv[1], 'r+b') as f:\n"
                      " Path(sys.argv[2]).touch()\n time.sleep(0.8)\n")
    binary.write_text("#!/usr/bin/env bash\nset -e\n"
                      "if [ \"$1\" = daemon ]; then\n"
                      " \"$TEST_PYTHON\" \"$TEST_HOLDER\" \"$0\" \"$TEST_MARKER\" >/dev/null 2>&1 &\n"
                      " while [ ! -f \"$TEST_MARKER\" ]; do sleep 0.02; done\n exit 0\nfi\n"
                      "touch \"$TEST_SERVER_READY\"\necho server-ready\n")
    binary.chmod(0o755)
    bindir = tmp / "bin"
    bindir.mkdir()
    curl = bindir / "curl"
    curl.write_text("#!/usr/bin/env bash\nset -e\nwhile [ $# -gt 0 ]; do\n"
                    " if [ \"$1\" = -o ]; then shift; cp \"$TEST_UPSTREAM\" \"$1\"; exit 0; fi\n shift\ndone\nexit 2\n")
    curl.chmod(0o755)
    upstream = tmp / "upstream.sh"
    upstream.write_text("#!/usr/bin/env bash\n#" + "fixture installer " * 20 + "\nexit 0\n")
    env = {**os.environ, "PATH": str(bindir) + os.pathsep + os.environ["PATH"],
           "CITADEL_LMSTUDIO_HOME": str(home), "TEST_UPSTREAM": str(upstream),
           "TEST_PYTHON": sys.executable, "TEST_HOLDER": str(holder),
           "TEST_MARKER": str(marker), "TEST_SERVER_READY": str(ready)}
    result = subprocess.run(["bash", str(root / "agent/lmstudio/install_llmstudio_headless.sh")],
                            env=env, capture_output=True, text=True, timeout=10, check=True)
    assert marker.exists(), "the fixture must hold the real executable open for writing"
    assert ready.exists(), "the installer returned before server startup"
    assert "localhost:1234 server are ready" in result.stdout
    # Errors unrelated to ETXTBSY still fail immediately, without false readiness.
    binary.write_text("#!/usr/bin/env bash\necho genuine-startup-failure >&2\nexit 7\n")
    ready.unlink()
    failed = subprocess.run(["bash", str(root / "agent/lmstudio/install_llmstudio_headless.sh")],
                            env=env, capture_output=True, text=True, timeout=10)
    assert failed.returncode == 7 and "genuine-startup-failure" in failed.stderr
    assert not ready.exists()
print("Linux installer: actual ETXTBSY recovery, verified server startup and genuine failure propagation PASS")
