# Cloudflare TEST deployment

The canonical site is `index.html`; `scripts/build_site.sh` creates an ignored `public/` bundle with
security headers. `wrangler.jsonc` defines the `citadel-ai` Worker and static assets. CI performs a
Wrangler dry run. The live site is deployed only by the protected **Deploy Cloudflare TEST** workflow
and only after the operator types `DEPLOY_TEST`.

## One-time GitHub environment configuration

Create the protected GitHub environment `cloudflare-test` and add:

- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account ID;
- `CLOUDFLARE_API_TOKEN` — a narrowly scoped token allowed to deploy only this Worker.

Do not commit either value. Require environment approval while EWS remains TEST-only. Once configured,
the workflow validates and deploys without local packaging or manual file copying.

## Current limitation

`https://citadel-ai.init1.workers.dev` was reachable during the 2026-09-05 review but served the old
v14 mixed Client/Architect page. This environment had no Cloudflare authentication, so replacing that
live deployment was technically impossible. A successful `wrangler deploy --dry-run` confirms the
bundle/configuration, not ownership of or permission to update the live account.
