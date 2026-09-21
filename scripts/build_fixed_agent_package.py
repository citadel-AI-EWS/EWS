#!/usr/bin/env python3
"""Build a self-contained Windows CITADEL agent repair package.

The builder packages the checked-in reviewed agent release without mutating source,
validates release pins, and emits one ZIP containing every install file.
It deliberately does not add SSH or arbitrary remote execution.
"""
from __future__ import annotations

import hashlib
import re
import shutil
import sys
import textwrap
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
PACKAGE_NAME = "CITADEL_FIXED_AGENT_0.3.13_2026-09-20"
STAGE = DIST / PACKAGE_NAME
ZIP_PATH = DIST / f"{PACKAGE_NAME}.zip"


def must_replace(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"expected source pattern not found: {label}")
    return text.replace(old, new, 1)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def indented_block(value: str, spaces: int = 8) -> str:
    block = textwrap.dedent(value).strip("\n") + "\n\n"
    return textwrap.indent(block, " " * spaces)


def patch_v1(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = must_replace(text, "import hashlib\n", "import hashlib\nimport ipaddress\n", "ipaddress import")
    text = must_replace(text, 'VERSION = "0.3.0"', 'VERSION = "0.3.13"', "v1 version")
    text = must_replace(
        text,
        'return json.loads(path.read_text(encoding="utf-8"))',
        'return json.loads(path.read_text(encoding="utf-8-sig"))',
        "BOM-tolerant JSON",
    )
    text = must_replace(
        text,
        'local_test = parsed.scheme == "http" and parsed.hostname == "127.0.0.1"',
        'local_test = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}',
        "loopback config",
    )
    text = must_replace(
        text,
        'elif self.scheme == "http" and self.host == "127.0.0.1":',
        'elif self.scheme == "http" and self.host in {"127.0.0.1", "localhost", "::1"}:',
        "loopback API client",
    )

    network_helper = textwrap.dedent('''
        TAILSCALE_INTERFACE_TOKEN = "tailscale"
        VIRTUAL_INTERFACE_TOKENS = (
            "loopback",
            "docker",
            "vethernet",
            "hyper-v",
            "vmware",
            "virtualbox",
            "wsl",
        )


        def local_network_addresses() -> dict[str, Any]:
            """Discover current host LAN/Tailscale IPv4 addresses without hard-coding DHCP data."""
            lan: list[str] = []
            tailscale: list[str] = []
            interfaces: list[dict[str, str]] = []
            try:
                stats = psutil.net_if_stats()
                addresses = psutil.net_if_addrs()
            except Exception:
                return {
                    "lan_ipv4": None,
                    "tailscale_ipv4": None,
                    "private_ipv4": [],
                    "interfaces": [],
                }

            for interface_name, items in addresses.items():
                state = stats.get(interface_name)
                if state is not None and not state.isup:
                    continue
                lowered = interface_name.lower()
                is_virtual = any(token in lowered for token in VIRTUAL_INTERFACE_TOKENS)
                for item in items:
                    if item.family != socket.AF_INET:
                        continue
                    try:
                        address = ipaddress.ip_address(item.address)
                    except ValueError:
                        continue
                    if (
                        address.is_loopback
                        or address.is_link_local
                        or address.is_multicast
                        or address.is_unspecified
                    ):
                        continue
                    value = str(address)
                    interfaces.append({"name": interface_name[:120], "ipv4": value})
                    if TAILSCALE_INTERFACE_TOKEN in lowered:
                        tailscale.append(value)
                    elif address.is_private and not is_virtual:
                        lan.append(value)

            lan = list(dict.fromkeys(lan))
            tailscale = list(dict.fromkeys(tailscale))
            return {
                "lan_ipv4": lan[0] if lan else None,
                "tailscale_ipv4": tailscale[0] if tailscale else None,
                "private_ipv4": lan,
                "interfaces": interfaces[:32],
            }


    ''')
    text = must_replace(
        text,
        "MissionHandler = Callable[[dict[str, Any]], dict[str, Any]]\n\n\ndef system_inventory",
        "MissionHandler = Callable[[dict[str, Any]], dict[str, Any]]\n\n\n" + network_helper + "def system_inventory",
        "network discovery helper",
    )
    text = must_replace(
        text,
        '        "disk_home_free_bytes": int(disk.free),\n    }',
        '        "disk_home_free_bytes": int(disk.free),\n        "network": local_network_addresses(),\n    }',
        "inventory network",
    )
    text = must_replace(
        text,
        "        self.last_heartbeat = 0.0\n",
        "        self.last_heartbeat = 0.0\n        self.enrollment_confirmed = False\n",
        "enrollment confirmation state",
    )

    enroll_pattern = re.compile(
        r"    def enroll\(self\) -> str:\n.*?\n    def heartbeat\(self\) -> None:\n",
        re.S,
    )
    enroll_replacement = '''    def enroll(self) -> str:
        if self.enrollment_confirmed and self.identity.node_id:
            return self.identity.node_id
        previous_node_id = self.identity.node_id
        response = self.api.request(
            "POST",
            "/api/v1/enroll",
            {
                "public_key": self.identity.public_jwk(),
                "hostname": socket.gethostname(),
                "os_name": platform.system() or "Unknown",
                "os_version": platform.release(),
                "architecture": platform.machine() or "unknown",
                "agent_version": VERSION,
                "capabilities": self.capabilities,
            },
            signed=False,
        )
        node = response.get("node", {})
        node_id = str(node.get("node_id") or "")
        node_number = int(node.get("node_number") or 0)
        if not node_id.startswith("node_") or node_number <= 0:
            raise RuntimeError("controller returned invalid node identity")
        if previous_node_id != node_id:
            self.identity.set_node_id(node_id)
        self.enrollment_confirmed = True
        self.log.write(
            "node_enrolled",
            node_id=node_id,
            node_number=node_number,
            reconciled=bool(previous_node_id and previous_node_id != node_id),
        )
        return node_id

    def heartbeat(self) -> None:
'''
    match = enroll_pattern.search(text)
    if not match:
        raise RuntimeError("expected enroll method not found")
    text = text[: match.start()] + enroll_replacement + text[match.end() :]

    text = must_replace(
        text,
        "    def heartbeat(self) -> None:\n        node_id = self.require_node_id()\n        self.api.request(\n",
        "    def heartbeat(self) -> None:\n        node_id = self.require_node_id()\n        network = local_network_addresses()\n        self.api.request(\n",
        "heartbeat network discovery",
    )
    text = must_replace(
        text,
        '                "capabilities": self.capabilities,\n            },\n        )\n        self.last_heartbeat = time.monotonic()',
        '                "capabilities": self.capabilities,\n                "network": {\n                    "lan_ipv4": network.get("lan_ipv4"),\n                    "tailscale_ipv4": network.get("tailscale_ipv4"),\n                },\n            },\n        )\n        self.last_heartbeat = time.monotonic()',
        "heartbeat network payload",
    )

    bom_test = indented_block('''
        bom_json = root / "bom.json"
        bom_json.write_bytes(b"\\xef\\xbb\\xbf{\\\"ok\\\":true}\\n")
        require_test(load_json(bom_json, {}).get("ok") is True, "UTF-8 BOM JSON rejected")
        network = local_network_addresses()
        require_test(
            set(network) == {"lan_ipv4", "tailscale_ipv4", "private_ipv4", "interfaces"},
            "network discovery returned an unexpected shape",
        )
    ''')
    text = must_replace(
        text,
        "        pending = ResultQueue(root / \"queue.json\")\n",
        bom_test + "        pending = ResultQueue(root / \"queue.json\")\n",
        "BOM/network self-test",
    )

    reconcile_test = indented_block('''
        reconcile_root = root / "reconcile"
        reconcile_root.mkdir()
        reconcile_config = AgentConfig(
            "https://example.test",
            reconcile_root,
            controller_public_x=controller_x,
        )
        reconcile_agent = Agent(reconcile_config)
        reconcile_agent.identity.set_node_id("node_stale")
        reconcile_agent.api.request = lambda *args, **kwargs: {
            "node": {"node_id": "node_reconciled", "node_number": 7}
        }
        require_test(
            reconcile_agent.enroll() == "node_reconciled"
            and reconcile_agent.identity.node_id == "node_reconciled",
            "stale node id was not reconciled with Controller",
        )
    ''')
    text = must_replace(
        text,
        '        require_test(system_inventory({})["memory_total_bytes"] > 0, "inventory failed")\n',
        '        require_test(system_inventory({})["memory_total_bytes"] > 0, "inventory failed")\n' + reconcile_test,
        "re-enrollment self-test",
    )

    path.write_text(text, encoding="utf-8", newline="\n")


def patch_v2(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = must_replace(text, 'VERSION = "0.3.0"', 'VERSION = "0.3.13"', "v2 version")
    path.write_text(text, encoding="utf-8", newline="\n")


def patch_setup(path: Path, v1_hash: str, v2_hash: str) -> None:
    text = path.read_text(encoding="utf-8")
    original = text
    text = re.sub(r'\$ExpectedV1Sha256 = "[0-9a-f]{64}"', f'$ExpectedV1Sha256 = "{v1_hash}"', text, count=1)
    text = re.sub(r'\$ExpectedV2Sha256 = "[0-9a-f]{64}"', f'$ExpectedV2Sha256 = "{v2_hash}"', text, count=1)
    text = text.replace('agent_version = "0.3.0"', 'agent_version = "0.3.13"')
    if text == original:
        raise RuntimeError("setup_windows.ps1 was not patched")
    path.write_text(text, encoding="utf-8", newline="\n")


def write_extras() -> None:
    (STAGE / "START_HERE.cmd").write_text(
        '@echo off\r\nsetlocal\r\ncall "%~dp0Install Windows Node.cmd" %*\r\n',
        encoding="utf-8",
        newline="",
    )
    readme = (
        "CITADEL/EWS — исправленный самодостаточный пакет 0.3.13\n\n"
        "1. Распакуйте ZIP полностью.\n"
        "2. Запустите START_HERE.cmd.\n"
        "3. Агент использует HTTPS Controller: https://citadel-ai.init1.workers.dev\n\n"
        "Исправлено в этом пакете:\n"
        "- JSON с UTF-8 BOM больше не ломает загрузку конфигурации.\n"
        "- При каждом запуске агент один раз сверяет node_id с Controller по Ed25519 public key; старый локальный ID автоматически исправляется.\n"
        "- localhost / 127.0.0.1 / ::1 согласованы для локального HTTP-теста.\n"
        "- Агент определяет текущий LAN/network IPv4; адреса не зашиты в код и могут меняться по DHCP.\n"
        "- LAN/network/MAC входят в system_inventory и heartbeat; Controller использует их для диагностики и ограниченного Wake-on-LAN.\n"
        "- Core Agent устанавливается как Windows Service CitadelEWSNode под LocalService с Automatic (Delayed Start).\n"        "- Read-only Enterprise Probe собирает CIM/Perf, Event Log, Windows Update, Hyper-V, domain/GPO, MDM/Intune и service-identity status без remote shell.\n"
        "- Старый Startup shortcut удаляется; существующая node identity мигрирует в ProgramData и сохраняется.\n"
        "- setup_windows.ps1 -Uninstall выполняет явное удаление; -PreserveState сохраняет node state по запросу.\n"
        "- В архиве находятся agent-файлы, проверяемый CitadelNodeService.cs и windows_service.ps1: установка не скачивает Python-код из GitHub.\n\n"
        "Произвольный SSH shell в пакет не включён. Разрешены только подписанные allowlist-команды Controller, включая reboot/shutdown и ограниченный wake_peer без shell.\n"
    )
    (STAGE / "README_RU.txt").write_text(readme, encoding="utf-8", newline="\n")
    verify = r'''[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Manifest = Join-Path $Root "SHA256SUMS.txt"
if (-not (Test-Path -LiteralPath $Manifest)) { throw "SHA256SUMS.txt not found" }
foreach ($line in Get-Content -LiteralPath $Manifest) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $parts = $line -split "  ", 2
  if ($parts.Count -ne 2) { throw "Invalid manifest line: $line" }
  $expected = $parts[0].Trim().ToLowerInvariant()
  $name = $parts[1].Trim()
  $path = Join-Path $Root $name
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing file: $name" }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Hash mismatch: $name" }
}
Write-Host "CITADEL package integrity: OK"
'''
    (STAGE / "VERIFY_PACKAGE.ps1").write_text(verify, encoding="utf-8", newline="\n")


def build() -> Path:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    DIST.mkdir(exist_ok=True)
    STAGE.mkdir(parents=True)
    for name in (
        "citadel_node_v1.py",
        "citadel_node_v2.py",
        "setup_windows.ps1",
        "Install Windows Node.cmd",
        "CitadelNodeService.cs",
        "windows_service.ps1",
        "windows_enterprise_probe.ps1",
        "requirements.txt",
        "requirements-win32.txt",
    ):
        shutil.copy2(ROOT / "agent" / name, STAGE / name)

    v1_path = STAGE / "citadel_node_v1.py"
    v2_path = STAGE / "citadel_node_v2.py"
    setup_path = STAGE / "setup_windows.ps1"
    v1_hash = sha256(v1_path)
    v2_hash = sha256(v2_path)
    if 'VERSION = "0.3.13"' not in v1_path.read_text(encoding="utf-8"):
        raise RuntimeError("repository v1 source is not release 0.3.13")
    if 'VERSION = "0.3.13"' not in v2_path.read_text(encoding="utf-8"):
        raise RuntimeError("repository v2 source is not release 0.3.13")
    setup_text = setup_path.read_text(encoding="utf-8")
    service_source = STAGE / "CitadelNodeService.cs"
    service_helper = STAGE / "windows_service.ps1"
    if f'$ExpectedV1Sha256 = "{v1_hash}"' not in setup_text:
        raise RuntimeError("setup_windows.ps1 v1 hash pin does not match repository source")
    if f'$ExpectedV2Sha256 = "{v2_hash}"' not in setup_text:
        raise RuntimeError("setup_windows.ps1 v2 hash pin does not match repository source")
    service_hash = sha256(service_source)
    if f'$ExpectedServiceHostSha256 = "{service_hash}"' not in setup_text:
        raise RuntimeError("setup_windows.ps1 service-host hash pin does not match repository source")
    helper_hash = sha256(service_helper)
    if f'$ExpectedServiceHelperSha256 = "{helper_hash}"' not in setup_text:
        raise RuntimeError("setup_windows.ps1 service-helper hash pin does not match repository source")
    enterprise_probe = STAGE / "windows_enterprise_probe.ps1"
    enterprise_probe_hash = sha256(enterprise_probe)
    if f'$ExpectedEnterpriseProbeSha256 = "{enterprise_probe_hash}"' not in setup_text:
        raise RuntimeError("setup_windows.ps1 enterprise-probe hash pin does not match repository source")
    if '$ReleaseVersion = "0.3.13"' not in setup_text:
        raise RuntimeError("setup_windows.ps1 release version is not 0.3.13")
    write_extras()

    manifest_names = sorted(
        path.name for path in STAGE.iterdir()
        if path.is_file() and path.name != "SHA256SUMS.txt"
    )
    manifest = "".join(f"{sha256(STAGE / name)}  {name}\n" for name in manifest_names)
    (STAGE / "SHA256SUMS.txt").write_text(manifest, encoding="utf-8", newline="\n")

    if ZIP_PATH.exists():
        ZIP_PATH.unlink()
    with zipfile.ZipFile(ZIP_PATH, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(STAGE.iterdir()):
            archive.write(path, f"{PACKAGE_NAME}/{path.name}")
    print(ZIP_PATH)
    print("v1_sha256", v1_hash)
    print("v2_sha256", v2_hash)
    return ZIP_PATH


if __name__ == "__main__":
    try:
        build()
    except Exception as exc:
        print(f"BUILD FAILED: {exc}", file=sys.stderr)
        raise
