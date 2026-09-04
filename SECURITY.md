# Security Policy

EWS includes security-oriented architecture concepts. Public collaboration must not expose real secrets or operational access.

## Never publish

- passwords or password verifiers;
- API keys or access tokens;
- SSH private keys;
- controller machine keys;
- recovery keys or recovery material;
- production client data;
- real infrastructure credentials;
- secrets copied from logs or screenshots.

## Reporting a vulnerability

For vulnerabilities in the public prototype, open an Issue only if the report can be safely public and contains no usable secret, private customer information, or active exploit material against a real third-party target.

For sensitive vulnerabilities, use a private security-reporting channel once one is configured for the repository. Until then, do not post sensitive exploit details publicly.

## Architecture expectations

Production implementations should use short-lived credentials, explicit privilege elevation, auditable administrative actions, isolated sandbox execution, network restrictions, secure secret storage, integrity verification, backups, and rollback mechanisms.
