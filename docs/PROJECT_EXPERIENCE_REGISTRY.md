# Project Experience Registry

The Project Experience Registry is the sanitized engineering memory exposed to the authenticated Architect console.

## Purpose

Historical reports are evidence, not runtime configuration. The registry converts reviewed evidence into compact records with:

- the problem that was observed;
- the evidence supporting the lesson;
- the engineering decision;
- the current replacement or guardrail;
- repository references that explain or test the decision.

## Storage boundary

The registry is intentionally separate from operational D1. Raw historical logs, old configuration files, archived binaries and credential material are not embedded in the Worker or Architect page.

The detailed sanitized legacy data remains reproducible from `knowledge/legacy_cre_experience.sql`. The compact runtime registry lives in `src/experience/registry.js`.

## Architect access

Authenticated Architect users can read the registry through:

`GET /api/v1/architect/experience`

The endpoint is read-only. It cannot mutate nodes, models, firewall rules or storage.

## Maintenance rule

Add a registry record only after evidence has been reviewed. Prefer a small durable lesson over copying raw logs. If a later implementation replaces an old lesson, keep the old record and update the replacement/reference rather than erasing the history.
