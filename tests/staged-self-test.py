"""Exercise release self-test from updater staging with inherited service flags."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="citadel-service-stage-") as directory:
        root = Path(directory)
        stage = root / "citadel-update-fixture"
        stage.mkdir()
        for name in ("citadel_node_v1.py", "citadel_node_v2.py"):
            shutil.copy2(ROOT / "agent" / name, stage / name)
        env = dict(os.environ)
        env["CITADEL_SERVICE_MANAGED"] = "1"
        for flag in ("STOP", "HOLD", "READY"):
            env[f"CITADEL_SERVICE_{flag}_FILE"] = str(root / flag)
        result = subprocess.run([sys.executable, str(stage / "citadel_node_v2.py"), "self-test"],
                                cwd=stage, env=env, capture_output=True, text=True, timeout=120)
        # These fixtures contain no production configuration or credentials.
        print(json.dumps({"test": "service-staged-self-test", "python": sys.version.split()[0],
                          "platform": sys.platform, "returncode": result.returncode,
                          "stdout": result.stdout[-4000:], "stderr": result.stderr[-8000:]}))
        if result.returncode:
            raise RuntimeError("staged self-test failed")


if __name__ == "__main__":
    main()
