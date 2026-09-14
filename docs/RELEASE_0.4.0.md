# CITADEL/EWS 0.4.0

Release date: 2026-09-15

## Operational result

- Windows node installs Python 3.14, creates an isolated environment, installs required packages, runs diagnostics and enrolls automatically.
- The node runs through `pythonw.exe`, starts after Windows sign-in and inhibits automatic system sleep while active.
- A newly enrolled node receives a sequential hub number and appears through the live Hub API and `/hub/` page.
- The Architect console can issue a signed remote update command.
- Remote updates accept only allowlisted agent files from the project repository, verify SHA-256, run the new agent self-test, back up existing files and roll back on failure.
- Arbitrary remote shell or arbitrary code execution remains unavailable.

## Install entry point

Run `Install Windows Node.cmd` from the extracted Windows package.

## Versions

- Project: 0.4.0
- Windows node: 0.3.0
