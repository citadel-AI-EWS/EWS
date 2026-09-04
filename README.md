# EWS — Expert Workspace System

EWS (Expert Workspace System) is an experimental architecture and interactive prototype for a distributed, multi-agent cloud workspace. The project explores how client tasks can move from intake through structured planning, isolated execution, verification, reporting, and operational oversight.

> **Project status:** active prototype / architecture simulation. The current repository contains an interactive browser simulation and project documentation. It is not yet a production deployment.

## What EWS explores

- Client and Architect roles with separate permissions and interfaces
- Dynamic multi-stage task pipelines rather than a fixed number of stages
- Local AI, Python workers, and hybrid execution modes
- Isolated sandbox execution with outbound networking disabled by default
- Multi-region compute orchestration and elastic worker allocation
- Versioned project uploads, Client Vault concepts, logs, analytics, and export
- Security Center, incident handling, audit trails, and controlled recovery flows
- Controller firmware/update lifecycle with staging, verification, rollback, and health checks
- Temporary, audited Architect SSH access rather than permanent exposed credentials
- Live cost visibility, project status, and client-facing progress controls

## Run the prototype

No build step is required.

1. Clone or download the repository.
2. Open `index.html` in a modern browser.
3. Switch between Client and Architect views to explore the simulation.

Some buttons intentionally simulate production workflows. Authentication, cloud infrastructure, billing, WebAuthn, SSH certificates, sandboxing, and real backend actions are represented as UI/architecture concepts unless explicitly implemented.

## Repository layout

```text
.
├── index.html                    # Current interactive EWS prototype
├── EWS_PROJECT_SOURCE_CURRENT.html # Preserved current source snapshot
├── docs/
│   ├── ARCHITECTURE.md
│   └── ROADMAP.md
├── .github/
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
└── LICENSE
```

## Contributing

Contributions are welcome. You can:

- open an Issue with a bug, design concern, or feature proposal;
- discuss architecture and UX improvements;
- submit a Pull Request with code or documentation changes;
- review proposed changes and add reactions/comments.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a Pull Request.

## Security

Do not publish credentials, private keys, recovery material, access tokens, client data, or real infrastructure secrets in Issues, Discussions, commits, or Pull Requests. See [SECURITY.md](SECURITY.md).

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
