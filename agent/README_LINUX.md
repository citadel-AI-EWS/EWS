CITADEL / EWS — Linux Node Installer 0.3.8

1. Extract the archive completely.
2. Run: bash START_HERE.sh
3. The installer verifies both agent files by SHA-256.
4. It creates a private Python venv, enrolls with the Controller, performs self-test + one live cycle, and installs a systemd service.
5. Re-running the installer repairs/updates the same installation and preserves node identity.

Default paths:
- application: ~/.local/share/citadel-node
- state/identity: ~/.local/state/citadel-node

For a non-root user the service is installed as a systemd user service.
For a root install it is installed as /etc/systemd/system/citadel-node.service.

No arbitrary remote shell is enabled.
