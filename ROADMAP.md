# EWS Roadmap

This roadmap is intentionally high-level. Items may be implemented independently and discussed through Issues and Pull Requests.

## Prototype hardening

- Split the current monolithic HTML prototype into maintainable HTML/CSS/JS modules.
- Add automated linting and basic browser tests.
- Make every interactive prototype control deterministic and testable.
- Improve RU/EN localization coverage.
- Improve responsive behavior for phone and tablet layouts.

## Backend foundation

- Define API contracts for projects, files, stages, agents, runs, costs, and security events.
- Add authentication and authorization boundaries for Client and Architect roles.
- Add persistent project/version metadata.
- Add immutable audit event storage.

## Execution and orchestration

- Implement controller scheduling and worker lifecycle management.
- Support dynamic/fixed/hybrid resource modes.
- Add multi-region placement policies.
- Add sandbox lifecycle, network policy, and run evidence capture.

## Security

- Implement WebAuthn/passkeys and recovery workflows.
- Add temporary Architect administrative access with short-lived credentials.
- Build Controller Update Manager with signature verification and rollback.
- Add secure secret management and credential isolation.
- Add Security Center event processing and policy actions.

## Client experience

- Versioned multi-file/folder intake.
- Voice-to-structured-brief workflow.
- Project status, stage progress, analytics, logs, and exports.
- Live spend versus budget and top-up flow.
- Feedback and public-review controls.

## Collaboration

- Maintain public Issues for bugs and proposals.
- Accept community Pull Requests.
- Add contributor documentation and architectural decision records as the codebase grows.
