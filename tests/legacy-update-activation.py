"""Run the exact historical 0.3.24 updater against the current two core files."""
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HISTORICAL_SHA = "030035b103d3300d57961ade248f0d2fb64c11c2"


def history(name):
    argv = ["git", "show", f"{HISTORICAL_SHA}:agent/{name}"]
    result = subprocess.run(argv, cwd=ROOT, capture_output=True, timeout=30, check=False)
    if result.returncode:
        subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", HISTORICAL_SHA],
                       cwd=ROOT, capture_output=True, timeout=90, check=True)
        result = subprocess.run(argv, cwd=ROOT, capture_output=True, timeout=30, check=True)
    return result.stdout


def main():
    names = ("citadel_node_v1.py", "citadel_node_v2.py")
    originals = {name: history(name) for name in names}
    assert b'VERSION = "0.3.24"' in originals[names[0]]
    # Windows checkout can convert LF to CRLF. HTTP release downloads contain
    # the exact Git blob bytes, so exercise those bytes and their pinned hashes.
    target = {name: subprocess.check_output(["git", "show", f"HEAD:agent/{name}"],
              cwd=ROOT, timeout=30) for name in names}
    source = (ROOT / "agent" / names[1]).read_text(encoding="utf-8")
    version = source.split('VERSION = "', 1)[1].split('"', 1)[0]
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        install = root / "agent"
        install.mkdir()
        for name in names:
            (install / name).write_bytes(originals[name])
        module_name = "citadel_historical_update_fixture"
        spec = importlib.util.spec_from_file_location(module_name, install / names[0])
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        config_path = root / "config.json"
        config_path.write_text(json.dumps({"controller_url": "https://example.invalid",
                                          "data_dir": str(root / "state")}), encoding="utf-8")
        agent = module.Agent(module.AgentConfig.from_file(config_path), config_path)
        agent.identity.set_node_id("node_historical_fixture")
        release = (ROOT / "src" / "index.js").read_text(encoding="utf-8").split("const LATEST_NODE_RELEASE =", 1)[1].split("\n});", 1)[0]
        files = [{"path": name, "url": url, "sha256": digest} for name, url, digest in
                 re.findall(r'path: "([^"]+)",\s+url: "([^"]+)",\s+sha256: "([^"]+)"', release)
                 if name in names]
        assert len(files) == 2
        assert all(item["sha256"] == hashlib.sha256(target[item["path"]]).hexdigest() for item in files)
        payload = {"version": version, "files": files}
        assert agent.validate_update_payload(payload)
        agent.download_update_file = lambda url: target[url.rsplit("/", 1)[-1]]
        agent.apply_update(payload)
        for name in names:
            assert (install / name).read_bytes() == target[name], name
        result = subprocess.run([sys.executable, str(install / names[1]), "probe", "--config", str(config_path)],
                                cwd=install, capture_output=True, text=True, timeout=30, check=True)
        proof = json.loads(result.stdout)
        assert proof["agent_version"] == version, proof
        assert proof["node_id"] == "node_historical_fixture", proof
        assert proof["check"] == "local_activation", proof
        # A damaged target must fail before replacing either installed core.
        damaged = {**target, names[1]: b"invalid Python syntax !!!"}
        bad = json.loads(json.dumps(payload))
        bad["files"][1]["sha256"] = hashlib.sha256(damaged[names[1]]).hexdigest()
        agent.download_update_file = lambda url: damaged[url.rsplit("/", 1)[-1]]
        try:
            agent.apply_update(bad)
        except RuntimeError:
            pass
        else:
            raise AssertionError("damaged target activated")
        for name in names:
            assert (install / name).read_bytes() == target[name], name
        print(json.dumps({"test": "historical-0.3.24-core-update", "platform": sys.platform,
                          "target_version": version, "fresh_process_activation": True,
                          "damaged_target_preserved_working_release": True}))


if __name__ == "__main__":
    main()
