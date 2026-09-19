# Cloudflare TEST deployment

The canonical operational site is built by `scripts/build_site.sh` into an ignored `public/` bundle
with security headers. `wrangler.jsonc` defines the `citadel-ai` Worker and static assets. CI performs
the validation gate first. A successful push to `main` automatically triggers the protected
**Deploy Cloudflare TEST** workflow for that exact CI-approved commit. A manual deployment remains
available only when the operator explicitly types `DEPLOY_TEST`.

## One-time GitHub environment configuration

Create the protected GitHub environment `cloudflare-test` and add:

- `CLOUDFLARE_API_TOKEN` — a narrowly scoped token allowed to deploy only this Worker;
- `ARCHITECT_TOKEN_HASH` — lowercase SHA-256 hex of the Architect bearer token, never the token itself;
- `CONTROLLER_COMMAND_PRIVATE_JWK` — the protected Ed25519 Controller signing private JWK.
- `OPENROUTER_API_KEY` — optional at deploy time, but required to activate the hidden final-answer
  quality gate. Store it only as a GitHub environment secret or Cloudflare Worker secret; never commit it.

To generate the Architect hash locally without exposing the token, use a trusted shell such as
`printf %s "$ARCHITECT_TOKEN" | sha256sum` and store only the 64-character digest as the GitHub
environment secret. Do not paste the bearer token or private signing JWK into issues, commits,
workflow logs, or chat.

Wrangler discovers the account from the token. `CLOUDFLARE_ACCOUNT_ID` is intentionally not passed,
which avoids deployment failures caused by a copied Zone ID or an incorrect account identifier.

Do not commit either value. Require environment approval while EWS remains TEST-only. Once configured,
the workflow validates and deploys without local packaging or manual file copying.

## Current limitation

`https://citadel-ai.init1.workers.dev` was reachable during the 2026-09-05 review but served the old
v14 mixed Client/Architect page. This environment had no Cloudflare authentication, so replacing that
live deployment was technically impossible. A successful `wrangler deploy --dry-run` confirms the
bundle/configuration, not ownership of or permission to update the live account.
