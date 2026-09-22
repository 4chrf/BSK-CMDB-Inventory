# BSK CMDB Inventory

**On-premise deployment is available:** [Step-by-step deployment guide](docs/ON_PREMISE.md). Run the standalone Node.js backend with MariaDB, local accounts and HTTPS using `compose.yaml`, or connect to a separate database VM with `compose.external-db.yaml`.

The `onprem/` backend is independent from the original Sites Worker described below. It does not use ChatGPT identity headers. Run `npm run test:onprem` for standalone security checks; the GitHub Actions workflow runs the MariaDB integration suite.

Application source for the private BSK Infrastructure CMDB Site. This public repository includes only three clearly marked fictional hosts and one demonstration rack. Production inventory, access records, user identities, credentials, original workbooks and private Site configuration are excluded.

## Build and test

Requires Node.js 22.13+ (SQLite test support) and npm.

```sh
npm ci
npm run build
npm test
node tests/ui.cjs
```

The output consists of `dist/server/index.js` (Cloudflare Worker) and `dist/client` (browser assets). The backend requires a D1 binding named `DB` and a static asset binding named `ASSETS`. Database initialization is non-destructive and inserts sample inventory only into a new workspace. Existing workspace records are preserved.

## Deployment and authentication

This source is designed for private OpenAI Sites dispatch. It is not a standalone password authentication server. Do not expose the Worker directly with caller-controlled identity headers. Outside Sites, implement a verified identity provider boundary before accepting requests. Never trust browser-supplied identity headers.

For a new private Site, obtain the exact authenticated Site-scoped owner subject from a trusted provisioning flow. Replace `REPLACE_WITH_VERIFIED_SITE_OWNER_SUBJECT` in `server/access.js`; do not copy the subject from an unverified request. Register the new Site and configure its private sharing and DB binding separately. This repository intentionally omits the production `.openai/hosting.json`.

`/` always shows read-only inventory. `/admin` requires both a trusted enabled administrator identity and an additional username/password session. No real password or administrator identity is included. Tests use a synthetic subject and fake passwords exclusively in isolated memory databases. New visitors receive read-only roles. Email does not grant administrator access.

Site sharing controls admission; application roles control inventory changes. Role changes are server-enforced and the last enabled administrator cannot be disabled or demoted. Sessions are identity-bound, hashed, short-lived, and revoked on demotion or disabling. Passwords use salted PBKDF2 and login attempts are rate limited. Missing stable identities fail closed and show a top-level sign-in recovery link.

The one-time owner reset in `server/admin-auth.js` reflects the September 22 source revision. It clears only the pinned owner's credentials and sessions once, records an audit event and leaves inventory intact. The next `/admin` visit allows that owner to set a new password. Remove this deployment-specific reset from future independent deployments if it is not required.

## Inventory workflows

- Hosts, racks and database-backed applications support administrator CRUD.
- Physical hosts support rack placements spanning several units. Virtual hosts use vCenter, cluster, ESXi host and VM name.
- Original CMDB fields, application records and source metadata are retained. Missing values remain undocumented.
- Deleting a rack retains its hosts and clears placements. Assigned applications cannot be deleted.
- CSV import, backup/restore, attributed history and data-quality filters are available to administrators.
- Search, room/rack navigation, host detail dialogs and responsive layouts serve read-only users.

## Verification

API and DOM tests cover authorization, CRUD, inventory preservation, last-administrator protection, role revocation, backup/restore, password reset, host popups and navigation. Responsive styles are included; live browser layout QA was unavailable in the source update environment. Production requests previously lacked the stable Sites identity header: if sign-in recovery still fails, the platform identity forwarding must be resolved. Do not bypass this requirement using email-only authorization.
