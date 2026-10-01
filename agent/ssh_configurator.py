#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

GLOBAL_BEGIN = "# BEGIN CITADEL EWS SSH GLOBAL"
GLOBAL_END = "# END CITADEL EWS SSH GLOBAL"
USER_BEGIN = "# BEGIN CITADEL EWS SSH USER"
USER_END = "# END CITADEL EWS SSH USER"
USER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class ConfigError(ValueError):
    pass


def _normalize_lines(text: str) -> list[str]:
    return text.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _remove_managed_block(lines: list[str], begin: str, end: str) -> list[str]:
    output: list[str] = []
    inside = False
    seen_begin = False
    seen_end = False
    for line in lines:
        if line.strip() == begin:
            if inside or seen_begin:
                raise ConfigError(f"duplicate managed marker: {begin}")
            inside = True
            seen_begin = True
            continue
        if line.strip() == end:
            if not inside or seen_end:
                raise ConfigError(f"unbalanced managed marker: {end}")
            inside = False
            seen_end = True
            continue
        if not inside:
            output.append(line)
    if inside or seen_begin != seen_end:
        raise ConfigError(f"unbalanced managed block: {begin}")
    return output


def _quote_command_arg(value: str) -> str:
    if not value or any(ch in value for ch in ('\r', '\n', '"')):
        raise ConfigError("unsafe ForceCommand path")
    return f'"{value}"'


def _first_match_index(lines: list[str]) -> int:
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and re.match(r"(?i)^match\s+", stripped):
            return idx
    return len(lines)


def _comment_conflicting_global(lines: list[str]) -> list[str]:
    result: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and re.match(r"(?i)^(listenaddress|port)\s+", stripped):
            result.append("# CITADEL disabled original: " + line)
        else:
            result.append(line)
    return result


def _reject_conflicting_forcecommand(lines: list[str], user: str) -> None:
    # Any pre-existing ForceCommand outside our managed block could win before
    # the CITADEL block for this account. Refuse instead of weakening policy.
    in_match = False
    match_targets_user = False
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if re.match(r"(?i)^match\s+", stripped):
            in_match = True
            words = stripped.split()
            lower = [w.lower() for w in words]
            match_targets_user = False
            if len(words) >= 3 and lower[1] == "user":
                candidates = [item for token in words[2:] for item in token.split(",")]
                match_targets_user = user.lower() in {item.lower() for item in candidates}
            continue
        if in_match and match_targets_user and re.match(r"(?i)^forcecommand\s+", stripped):
            raise ConfigError("existing ForceCommand already applies to requested SSH user")


def render_config(
    text: str,
    *,
    user: str,
    python_path: str,
    console_path: str,
    agent_config_path: str,
) -> str:
    if not USER_RE.fullmatch(user):
        raise ConfigError("invalid SSH username")
    lines = _normalize_lines(text)
    lines = _remove_managed_block(lines, GLOBAL_BEGIN, GLOBAL_END)
    lines = _remove_managed_block(lines, USER_BEGIN, USER_END)
    _reject_conflicting_forcecommand(lines, user)

    first_match = _first_match_index(lines)
    global_lines = _comment_conflicting_global(lines[:first_match])
    remainder = lines[first_match:]

    command = " ".join(
        (
            _quote_command_arg(python_path),
            _quote_command_arg(console_path),
            "--config",
            _quote_command_arg(agent_config_path),
        )
    )

    managed_global = [
        GLOBAL_BEGIN,
        "Port 22",
        "ListenAddress 127.0.0.1",
        GLOBAL_END,
        "",
    ]
    managed_user = [
        USER_BEGIN,
        f"Match User {user}",
        f"    ForceCommand {command}",
        "    PermitTTY yes",
        "    AllowTcpForwarding no",
        "    X11Forwarding no",
        "    PermitTunnel no",
        "    GatewayPorts no",
        USER_END,
        "Match all",
        "",
    ]

    result = global_lines + managed_global + managed_user + remainder
    return "\n".join(result).rstrip() + "\n"


def inspect_config(text: str, *, user: str | None = None) -> dict[str, object]:
    lines = _normalize_lines(text)
    joined = "\n".join(lines)
    global_present = GLOBAL_BEGIN in joined and GLOBAL_END in joined
    user_present = USER_BEGIN in joined and USER_END in joined
    loopback = False
    port_22 = False
    force_command = False
    forwarding_disabled = False
    matched_user = None

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.lower() == "listenaddress 127.0.0.1":
            loopback = True
        elif stripped.lower() == "port 22":
            port_22 = True
        elif re.match(r"(?i)^match\s+user\s+", stripped):
            matched_user = stripped.split(None, 2)[2].split(",")[0]
        elif stripped.lower().startswith("forcecommand ") and "ssh_restricted_console.py" in stripped:
            force_command = True

    lower = joined.lower()
    forwarding_disabled = all(
        token in lower
        for token in (
            "allowtcpforwarding no",
            "x11forwarding no",
            "permittunnel no",
            "gatewayports no",
        )
    )
    user_ok = True if user is None else bool(
        user_present and re.search(rf"(?im)^\s*Match\s+User\s+{re.escape(user)}\s*$", joined)
    )
    return {
        "schema": "citadel.ssh-config-inspection.v1",
        "managed_global": global_present,
        "managed_user": user_present,
        "user": matched_user,
        "requested_user_matches": user_ok,
        "port_22": port_22,
        "loopback_only_configured": loopback,
        "force_command_configured": force_command,
        "forwarding_disabled": forwarding_disabled,
        "ready": bool(
            global_present
            and user_present
            and user_ok
            and port_22
            and loopback
            and force_command
            and forwarding_disabled
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    render = sub.add_parser("render")
    render.add_argument("--input", required=True)
    render.add_argument("--output", required=True)
    render.add_argument("--user", required=True)
    render.add_argument("--python", required=True)
    render.add_argument("--console", required=True)
    render.add_argument("--agent-config", required=True)

    inspect = sub.add_parser("inspect")
    inspect.add_argument("--input", required=True)
    inspect.add_argument("--user")

    args = parser.parse_args()
    source = Path(args.input)
    text = source.read_text(encoding="utf-8-sig")

    if args.command == "render":
        rendered = render_config(
            text,
            user=args.user,
            python_path=args.python,
            console_path=args.console,
            agent_config_path=args.agent_config,
        )
        Path(args.output).write_text(rendered, encoding="utf-8", newline="\n")
        return 0

    result = inspect_config(text, user=args.user)
    print(json.dumps(result, sort_keys=True))
    return 0 if result["ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
