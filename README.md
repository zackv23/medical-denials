# DenialOps — medical claim denial recovery (Cloudflare Workers)

One Worker serves the static site (`public/`), the JSON API, and a remote MCP server. Storage: **D1** (data), **R2** (uploaded files).

## Pages
| Page | Purpose |
|---|---|
| `/` | Hero + year-end sign-up bonus ($1,000 / 1 doctor · $2,500 / 2 doctors · $5,000 / 3+ doctors, through 2026-12-31) |
| `/signup.html`, `/login.html` | Create account / log in (PBKDF2 passwords, HttpOnly session cookie) |
| `/account.html` | Log out, create a new account, **delete account** (password + typed DELETE; wipes DB rows and R2 files) |
| `/hipaa.html` | HIPAA release + BAA acknowledgment with e-signature (required before uploads/ingest/MCP) |
| `/dashboard.html` | Onboarding checklist + claims tracking (status workflow, appeal drafts) |
| `/upload.html` | Upload X12 835 / CSV / denial letters; add single denials |
| `/integrations.html` | **EZ Quick Connect** (7-day link + ingest credentials) and **MCP tokens** |
| `/connect/<token>` | Public, token-gated page where the practice's EHR/billing admin submits integration credentials (AES-GCM encrypted) |

## MCP
`POST /mcp` (Streamable HTTP, JSON-RPC, `Authorization: Bearer dop_…`). Tools: `get_summary`, `list_claims`, `get_claim`, `update_claim_status`, `add_denial`, `parse_835`, `draft_appeal`, `list_connections`.
```bash
claude mcp add --transport http denialops https://<your-worker>/mcp --header "Authorization: Bearer <token>"
```

## Ingest API (for connected systems)
`POST /api/ingest` with `X-Ingest-Key: dopi_…` and body = raw 835 text or `{"claims":[{"claim_id","carc","denied"}]}`.

## Run locally
```bash
npm install
cp .dev.vars.example .dev.vars   # set ENCRYPTION_KEY (openssl rand -base64 32)
npm run db:migrate:local
npm run dev                      # http://localhost:8787
npm test                         # end-to-end smoke test against the dev server
```

## Deploy
```bash
npx wrangler d1 create denialops          # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create denialops-files
npx wrangler secret put ENCRYPTION_KEY
npm run db:migrate:remote && npm run deploy
```

## Before real PHI — required
This is a working scaffold, **not** a HIPAA-compliant production system yet:
- Execute a **BAA with Cloudflare** (and confirm which products are covered) before storing PHI.
- Have a healthcare attorney review `HIPAA_FORM_TEXT` in `src/lib.ts` (it is a template) and the bonus terms.
- Add login rate limiting (Cloudflare WAF/Turnstile), email verification, password reset, MFA, and a data-retention policy (HIPAA records are generally kept 6 years; account deletion here hard-deletes everything).
- EHR/billing "quick connect" stores encrypted credentials and exposes an ingest endpoint; vendor-specific connectors (Epic FHIR, athenahealth, Waystar, …) are not built yet.

## CI/CD (GitHub Actions → Cloudflare)
`.github/workflows/deploy.yml` runs on every push to `main` (or manually): typecheck, apply D1 migrations, `wrangler deploy`.
One-time setup:
1. Create the D1 database and R2 bucket (see Deploy) and put the real `database_id` in `wrangler.jsonc`.
2. `npx wrangler secret put ENCRYPTION_KEY`
3. In GitHub → Settings → Secrets and variables → Actions, add `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers" + D1 Edit + R2 Edit) and `CLOUDFLARE_ACCOUNT_ID`.
