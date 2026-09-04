# EWS Architecture Overview

## 1. Roles

### Client
The client submits a task, uploads project files, follows project progress, views costs and reports, uses sandbox-related features allowed by policy, and manages project-facing settings. The client does not receive infrastructure-level control over worker nodes.

### Architect
The Architect has operational visibility into projects, stages, workers, regions, security events, expenses, controller state, and recovery/update workflows. Privileged actions must be authenticated, scoped, time-limited where appropriate, and auditable.

## 2. Intake and project data

A project begins with text, voice transcription, files, folders, or archives. New uploads are versioned rather than silently overwriting prior inputs. The conceptual Client Vault isolates data per client/project and supports retention and export policies.

## 3. Dynamic pipeline

The pipeline is created from the actual task rather than from a fixed global number of stages. A typical flow is:

1. Raw intake and inventory
2. Cleaning / normalization
3. Semantic structuring and constraints
4. Task graph creation
5. Worker allocation
6. Isolated execution
7. Verification / cross-checking
8. Synthesis and reporting

The controller may expand, split, retry, merge, or stop stages based on task state.

## 4. Execution layer

Workers may run:

- deterministic Python tooling;
- local LLM inference;
- hybrid AI + Python workflows;
- specialized task agents.

Resource allocation can be dynamic, fixed, or hybrid and may span multiple regions.

## 5. Sandbox

Client code should run in an isolated environment. Outbound networking is disabled by default. Optional network access should be scoped by allowlist and logged. Runs are versioned and should capture relevant logs, resource usage, failures, and outputs.

## 6. Controller

The Controller coordinates project state, workers, task stages, placement, updates, security policy, and reporting.

Controller updates should follow a controlled lifecycle:

1. Upload / staging
2. Checksum and signature verification
3. Compatibility and preflight checks
4. Backup of current version and configuration
5. Explicit install confirmation
6. Controlled restart
7. Health check
8. Automatic rollback on failure

## 7. Privileged access

Architect SSH access should be temporary and explicitly approved. The intended model uses short-lived certificates or access grants with TTL, limited scope, audit records, and no display of private keys in the UI.

Credential categories such as Architect identity/recovery, controller machine identity, SSH CA material, and recovery secrets should remain isolated from one another.

## 8. Security Center

The Security Center records and reacts to suspicious or prohibited behavior such as access-control bypass attempts, request manipulation, injection, and forbidden commands. Actions may include warnings, session isolation, project suspension, blocking, and false-positive review.

## 9. Observability and cost

EWS aims to expose project progress, timing, resource usage, logs, analytics, and cost to the appropriate role. Client views should explain spend versus paid budget without exposing infrastructure details that are unnecessary for the client.
