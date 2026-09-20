CITADEL / EWS — Linux Node Installer 0.3.11-linuxcompat.1

Supported targets:
- Linux x86_64 / amd64
- Linux ARM64 / aarch64
- Python 3.12 through 3.14, 64-bit
- systemd-based distributions

1. Extract the matching archive completely.
2. Run: bash START_HERE.sh
3. The installer checks the package target architecture against the computer.
4. It verifies both agent files by SHA-256.
5. It creates a private Python venv, installs only prebuilt binary wheels, enrolls with the Controller, performs self-test + one live cycle, and installs a systemd service.
6. Re-running the installer repairs/updates the same installation and preserves node identity.

Packages:
- CITADEL_LINUX_X86_64_AGENT_0.3.11_COMPAT1.tar.gz
- CITADEL_LINUX_ARM64_AGENT_0.3.11_COMPAT1.tar.gz

Default paths:
- application: ~/.local/share/citadel-node
- state/identity: ~/.local/state/citadel-node

For a non-root user the service is installed as a systemd user service.
For a root install it is installed as /etc/systemd/system/citadel-node.service.

The installer intentionally does not compile C/Rust Python dependencies locally. If a compatible binary wheel is unavailable for the current Python/Linux combination, installation stops instead of building unreviewed native code.

32-bit x86 Linux and 32-bit ARM (armv7/armhf) are not supported by this compatibility release.

No arbitrary remote shell is enabled.
