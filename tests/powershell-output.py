"""Regress the physical canary's missing PowerShell stdout and Windows decoding."""
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import citadel_node_v1 as node

with patch.object(node.os, "name", "nt"), patch.object(node.shutil, "which", return_value="powershell.exe"):
    for output in (None, "", " ", "not-json"):
        with patch.object(node, "_citadel_subprocess_run", return_value=SimpleNamespace(returncode=0, stdout=output)):
            assert node._doctor_powershell_json("Get-CimInstance Win32_NetworkAdapter") is None
    value = {"Name": "רשת — сетевой адаптер", "MACAddress": "00:11:22:33:44:55"}
    with patch.object(node, "_citadel_subprocess_run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(value, ensure_ascii=False))) as run:
        assert node._doctor_powershell_json("Get-CimInstance Win32_NetworkAdapter") == value
        assert run.call_args.kwargs["encoding"] == "utf-8"
        assert run.call_args.kwargs["errors"] == "replace"
        assert "OutputEncoding" in run.call_args.args[0][-1]
    with patch.object(node.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="")) as run:
        node._citadel_subprocess_run(["powershell.exe"], text=True, capture_output=True)
        assert run.call_args.kwargs["errors"] == "replace"
        node._citadel_subprocess_run(["powershell.exe"], capture_output=True)
        assert "errors" not in run.call_args.kwargs, "binary transport must remain binary"

if sys.platform == "win32":
    result = node._citadel_subprocess_run([sys.executable, "-c", "import sys;sys.stdout.buffer.write(bytes([255,129]))"],
                                        text=True, encoding="utf-8", capture_output=True, timeout=10)
    assert result.returncode == 0 and isinstance(result.stdout, str) and "\ufffd" in result.stdout
    assert node._doctor_powershell_json("[pscustomobject]@{Name=[string]([char]0x5e8);MACAddress='00:11:22:33:44:55'}|ConvertTo-Json -Compress") == {
        "Name": "ר", "MACAddress": "00:11:22:33:44:55"}
print("Windows PowerShell output: missing/invalid JSON, Unicode and real child decoding PASS")
