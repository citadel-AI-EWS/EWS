"""Read-only hardware and network diagnostics for CITADEL nodes.

This module deliberately avoids device writes, firmware flashing, USB probing,
network reconfiguration, credential access, and arbitrary shell execution.
It reuses ideas from older production diagnostics: physical NIC discovery,
MAC/PCI identity, VPD/driver/firmware metadata and staged network health checks.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import socket
import subprocess  # nosec B404
import urllib.parse
from pathlib import Path
from typing import Any

import psutil


VIRTUAL_INTERFACE_TOKENS = (
    "loopback",
    "docker",
    "vethernet",
    "hyper-v",
    "vmware",
    "virtualbox",
    "wsl",
    "tailscale",
)


def _normalize_mac(value: str) -> str | None:
    compact = "".join(ch for ch in str(value) if ch.isalnum()).upper()
    if len(compact) != 12 or any(ch not in "0123456789ABCDEF" for ch in compact):
        return None
    if compact == "000000000000":
        return None
    return ":".join(compact[index:index + 2] for index in range(0, 12, 2))


def _read_text(path: Path, limit: int = 240) -> str | None:
    try:
        value = path.read_text(encoding="utf-8", errors="replace").strip()
    except (OSError, UnicodeError):
        return None
    return value[:limit] or None


def _powershell_json(command: str, timeout: int = 12) -> Any:
    if os.name != "nt":
        return None
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        return None
    try:
        result = subprocess.run(  # nosec B603
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            timeout=timeout,
            capture_output=True,
            text=True,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def _pci_ids_from_pnp_id(value: str) -> dict[str, str]:
    text = str(value or "").upper()
    result: dict[str, str] = {}
    for key, pattern in (
        ("vendor_id", r"(?:VEN|VID)_([0-9A-F]{4})"),
        ("device_id", r"(?:DEV|PID)_([0-9A-F]{4})"),
        ("subsystem_id", r"SUBSYS_([0-9A-F]{8})"),
    ):
        match = re.search(pattern, text)
        if match:
            result[key] = match.group(1)
    return result


def local_interfaces() -> list[dict[str, Any]]:
    try:
        stats = psutil.net_if_stats()
        addresses = psutil.net_if_addrs()
    except Exception:
        return []
    link_family = getattr(psutil, "AF_LINK", None)
    rows: list[dict[str, Any]] = []
    for name, items in addresses.items():
        lowered = name.lower()
        if any(token in lowered for token in VIRTUAL_INTERFACE_TOKENS):
            continue
        state = stats.get(name)
        row: dict[str, Any] = {
            "name": name[:120],
            "is_up": bool(state.isup) if state is not None else None,
            "speed_mbps": int(state.speed) if state is not None and state.speed >= 0 else None,
            "mtu": int(state.mtu) if state is not None and state.mtu > 0 else None,
            "ipv4": [],
            "mac": None,
        }
        for item in items:
            if item.family == socket.AF_INET:
                address = str(item.address or "").strip()
                if address and not address.startswith("127.") and not address.startswith("169.254."):
                    row["ipv4"].append(address)
            elif link_family is not None and item.family == link_family:
                row["mac"] = row["mac"] or _normalize_mac(str(item.address or ""))
        if row["ipv4"] or row["mac"]:
            rows.append(row)
    return rows[:32]


def windows_network_devices() -> list[dict[str, Any]]:
    decoded = _powershell_json(
        "Get-CimInstance Win32_NetworkAdapter | "
        "Where-Object {$_.PhysicalAdapter -eq $true} | "
        "Select-Object Name,Manufacturer,MACAddress,Speed,PNPDeviceID,"
        "NetConnectionID,NetConnectionStatus | ConvertTo-Json -Compress"
    )
    rows = decoded if isinstance(decoded, list) else ([decoded] if isinstance(decoded, dict) else [])
    drivers_decoded = _powershell_json(
        "Get-CimInstance Win32_PnPSignedDriver | "
        "Where-Object {$_.DeviceClass -eq 'NET'} | "
        "Select-Object DeviceName,Manufacturer,DriverVersion,DriverDate,DeviceID | "
        "ConvertTo-Json -Compress"
    )
    drivers = drivers_decoded if isinstance(drivers_decoded, list) else (
        [drivers_decoded] if isinstance(drivers_decoded, dict) else []
    )
    by_device_id = {
        str(item.get("DeviceID") or "").upper(): item
        for item in drivers
        if isinstance(item, dict) and item.get("DeviceID")
    }
    result: list[dict[str, Any]] = []
    for item in rows[:32]:
        if not isinstance(item, dict):
            continue
        pnp_id = str(item.get("PNPDeviceID") or "")
        driver = by_device_id.get(pnp_id.upper(), {})
        speed = item.get("Speed")
        row: dict[str, Any] = {
            "name": str(item.get("NetConnectionID") or item.get("Name") or "")[:160],
            "description": str(item.get("Name") or "")[:200] or None,
            "manufacturer": str(item.get("Manufacturer") or driver.get("Manufacturer") or "")[:160] or None,
            "mac": _normalize_mac(str(item.get("MACAddress") or "")),
            "speed_bps": int(speed) if isinstance(speed, (int, float)) and speed >= 0 else None,
            "driver_version": str(driver.get("DriverVersion") or "")[:80] or None,
            "driver_date": str(driver.get("DriverDate") or "")[:80] or None,
            "pnp_device_id": pnp_id[:240] or None,
            "source": "windows_cim_readonly",
        }
        row.update(_pci_ids_from_pnp_id(pnp_id))
        result.append({key: value for key, value in row.items() if value is not None})
    return result


def _ethtool_driver(interface_name: str) -> dict[str, str]:
    executable = shutil.which("ethtool")
    if not executable:
        return {}
    try:
        result = subprocess.run(  # nosec B603
            [executable, "-i", interface_name],
            timeout=5,
            capture_output=True,
            text=True,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    mapped: dict[str, str] = {}
    keys = {
        "driver": "driver",
        "version": "driver_version",
        "firmware-version": "firmware_version",
        "bus-info": "pci_address",
    }
    for line in result.stdout.splitlines():
        key, sep, value = line.partition(":")
        target = keys.get(key.strip().lower())
        if sep and target and value.strip():
            mapped[target] = value.strip()[:160]
    return mapped


def _linux_vpd_summary(pci_address: str) -> dict[str, str]:
    executable = shutil.which("lspci")
    if not executable or not pci_address:
        return {}
    try:
        result = subprocess.run(  # nosec B603
            [executable, "-s", pci_address, "-vv"],
            timeout=6,
            capture_output=True,
            text=True,
            errors="replace",
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    summary: dict[str, str] = {}
    for raw_line in result.stdout.splitlines():
        stripped = raw_line.strip()
        normalized = re.sub(r"^\[[A-Za-z0-9]+\]\s*", "", stripped)
        key, sep, value = normalized.partition(":")
        target = {
            "product name": "product_name",
            "part number": "part_number",
            "revision": "revision",
            "serial number": "serial_number",
        }.get(key.strip().lower())
        if sep and target and value.strip():
            summary[target] = value.strip()[:200]
    return summary


def linux_network_devices() -> list[dict[str, Any]]:
    if os.name == "nt":
        return []
    try:
        names = list(psutil.net_if_addrs())
    except Exception:
        return []
    result: list[dict[str, Any]] = []
    sys_net = Path("/sys/class/net")
    for name in names[:64]:
        lowered = name.lower()
        if any(token in lowered for token in VIRTUAL_INTERFACE_TOKENS):
            continue
        device_link = sys_net / name / "device"
        if not device_link.exists():
            continue
        try:
            resolved = device_link.resolve()
        except OSError:
            resolved = device_link
        pci_address = resolved.name
        driver_name = None
        with contextlib.suppress(OSError):
            driver_name = (device_link / "driver").resolve().name
        row: dict[str, Any] = {
            "name": name[:120],
            "pci_address": pci_address[:40],
            "vendor_id": (_read_text(device_link / "vendor") or "").removeprefix("0x").upper() or None,
            "device_id": (_read_text(device_link / "device") or "").removeprefix("0x").upper() or None,
            "subsystem_vendor_id": (_read_text(device_link / "subsystem_vendor") or "").removeprefix("0x").upper() or None,
            "subsystem_device_id": (_read_text(device_link / "subsystem_device") or "").removeprefix("0x").upper() or None,
            "driver": driver_name,
            "vpd_available": (device_link / "vpd").exists(),
            "source": "linux_sysfs_readonly",
        }
        row.update(_ethtool_driver(name))
        row.update(_linux_vpd_summary(pci_address))
        result.append({key: value for key, value in row.items() if value is not None})
    return result


def network_devices() -> list[dict[str, Any]]:
    return windows_network_devices() if os.name == "nt" else linux_network_devices()


def default_routes() -> list[dict[str, Any]]:
    if os.name == "nt":
        decoded = _powershell_json(
            "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | "
            "Sort-Object RouteMetric | Select-Object -First 4 "
            "InterfaceAlias,NextHop,RouteMetric,State | ConvertTo-Json -Compress"
        )
        rows = decoded if isinstance(decoded, list) else ([decoded] if isinstance(decoded, dict) else [])
        return [
            {
                "interface": str(item.get("InterfaceAlias") or "")[:120] or None,
                "gateway": str(item.get("NextHop") or "")[:64] or None,
                "metric": item.get("RouteMetric"),
                "state": str(item.get("State") or "")[:40] or None,
            }
            for item in rows[:4]
            if isinstance(item, dict)
        ]

    try:
        lines = Path("/proc/net/route").read_text(
            encoding="ascii", errors="replace"
        ).splitlines()[1:]
    except OSError:
        return []
    rows: list[dict[str, Any]] = []
    for line in lines:
        fields = line.split()
        if len(fields) < 8 or fields[1] != "00000000":
            continue
        try:
            gateway_raw = int(fields[2], 16).to_bytes(4, "little")
            gateway = socket.inet_ntoa(gateway_raw)
            metric = int(fields[6])
        except (ValueError, OSError):
            continue
        rows.append({"interface": fields[0][:120], "gateway": gateway, "metric": metric})
    return rows[:4]


def hardware_doctor_snapshot() -> dict[str, Any]:
    interfaces = local_interfaces()
    devices = network_devices()
    macs = [str(row.get("mac")) for row in interfaces if row.get("mac")]
    duplicate_macs = sorted({value for value in macs if macs.count(value) > 1})
    return {
        "schema": "citadel.hardware-doctor.v1",
        "readonly": True,
        "usb_scanning": False,
        "network_interfaces": interfaces,
        "network_devices": devices,
        "default_routes": default_routes(),
        "checks": {
            "physical_network_present": bool(devices or macs),
            "duplicate_mac_addresses": duplicate_macs,
            "pci_metadata_available": any(
                item.get("pci_address") or item.get("pnp_device_id")
                for item in devices
                if isinstance(item, dict)
            ),
            "firmware_metadata_available": any(
                item.get("firmware_version")
                for item in devices
                if isinstance(item, dict)
            ),
            "vpd_metadata_available": any(
                item.get("vpd_available") or item.get("product_name") or item.get("part_number")
                for item in devices
                if isinstance(item, dict)
            ),
        },
    }


def network_doctor_snapshot(controller_url: str) -> dict[str, Any]:
    parsed = urllib.parse.urlsplit(controller_url)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    interfaces = local_interfaces()
    routes = default_routes()
    checks: list[dict[str, Any]] = [
        {
            "name": "local_interface",
            "ok": any(row.get("is_up") and row.get("ipv4") for row in interfaces),
            "detail": next(
                (
                    ", ".join(row.get("ipv4") or [])
                    for row in interfaces
                    if row.get("is_up") and row.get("ipv4")
                ),
                "no active physical IPv4 interface detected",
            ),
        },
        {
            "name": "default_route",
            "ok": bool(routes),
            "detail": routes[0].get("gateway") if routes else "default route not detected",
        },
    ]

    resolved: list[str] = []
    dns_error = None
    try:
        resolved = list(
            dict.fromkeys(
                item[4][0]
                for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
                if item and item[4]
            )
        )[:8]
    except OSError as error:
        dns_error = type(error).__name__
    checks.append(
        {
            "name": "controller_dns",
            "ok": bool(resolved),
            "detail": ", ".join(resolved) if resolved else (dns_error or "resolution failed"),
        }
    )

    tcp_ok = False
    tcp_error = None
    if resolved:
        try:
            with socket.create_connection((host, port), timeout=3.0):
                tcp_ok = True
        except OSError as error:
            tcp_error = type(error).__name__
    checks.append(
        {
            "name": "controller_tcp",
            "ok": tcp_ok,
            "detail": f"{host}:{port}" if tcp_ok else (tcp_error or "not attempted"),
        }
    )

    passed = sum(1 for item in checks if item.get("ok"))
    return {
        "schema": "citadel.network-doctor.v1",
        "readonly": True,
        "controller_host": host,
        "controller_port": port,
        "checks": checks,
        "passed": passed,
        "total": len(checks),
        "status": "ok" if passed == len(checks) else ("degraded" if passed >= 2 else "failed"),
    }
