# Contributing to EWS

Thank you for helping improve EWS.

## Ways to contribute

- Report reproducible bugs.
- Suggest architecture, security, UX, observability, or cost-control improvements.
- Improve documentation and translations.
- Submit code through Pull Requests.
- Review open Pull Requests and Issues.

## Before opening a Pull Request

1. Check existing Issues and Pull Requests for duplicates.
2. Keep each Pull Request focused on one logical change.
3. Explain the problem, the proposed change, and how you tested it.
4. Avoid committing credentials, tokens, private keys, customer data, or infrastructure secrets.
5. Preserve the distinction between **prototype/simulation behavior** and **production-ready behavior**.

## Project principles

Changes should preserve these core ideas unless a proposal explicitly argues for changing them:

- least-privilege access;
- client/architect role separation;
- isolated execution by default;
- explicit confirmation for destructive or privileged actions;
- versioning and auditability of important changes;
- recovery and rollback paths for controller and infrastructure changes;
- clear client-facing status, cost, and project visibility;
- dynamic allocation rather than a hard-coded node count.

## Pull Request review

Maintainers may request changes for security, maintainability, architecture consistency, or unclear production assumptions. Substantial changes should normally begin with an Issue so the design can be discussed first.

## Required validation

Run `scripts/validate.sh` before every commit. Generated deployment ZIP files must not be committed;
`scripts/package_controller.sh` builds them from canonical sources. For visible UI changes, exercise
the Architect flow in a browser and update the screenshot only when it documents the current state.
AWS integration tests must use synthetic data in a dedicated budget-capped non-production account.
