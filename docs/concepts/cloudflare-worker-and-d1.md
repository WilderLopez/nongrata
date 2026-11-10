---
tags: [concept]
aliases: [Worker, D1, wrangler, Cloudflare]
---

# Cloudflare Worker and D1

*Español: [cloudflare-worker-y-d1.md](../es/conceptos/cloudflare-worker-y-d1.md)*

The nongrata server is not a machine you have to maintain: it is a Cloudflare **Worker** with a
**D1** database. This note explains those pieces for someone coming from iOS.

## Worker

A Worker is a function Cloudflare runs on its servers every time an HTTP request arrives. You
upload the code; Cloudflare provides the machines, the network and HTTPS.

Ours is written in TypeScript and has two entry points (`worker/src/index.ts`):

- `fetch`: handles HTTP requests.
  - `POST /v1/device/check`: the check the app sends. See [Check flow](check-flow.md).
  - `/v1/admin/*`: ban, unban and look up. Used by the CLI with `ADMIN_TOKEN`.
- `scheduled`: called by the Cron Trigger (see below).

Free plan: 100,000 requests per day and 10 ms of CPU per request. Waiting on Apple does not
count as CPU. If the daily quota runs out (error 1027), the app treats it as a failure:
fail-open (see [Fail-open and observation mode](fail-open-and-observation.md)).

## D1

A SQLite database managed by Cloudflare. The Worker sees it as `env.DB`.

| Table | What it stores |
|---|---|
| `banned_ids` | The banned hashes, with `reason` = `manual` or `propagated`. Key `(app, hash)`. |
| `unban_refs` | The unbans by `ref`: pending or already consumed. |
| `check_log` | The result of each check. Never identifiers or IPs. |

- D1 was chosen over KV because what is written can be read right away. In KV a change can take
  60 s or more to show up, and there are few free writes.
- Free plan: 5 million rows read and 100,000 written per day; 500 MB per database.
- Tables are created with **migrations**: SQL files in `worker/migrations/` that wrangler applies
  in order.
- Timestamps are Unix milliseconds.

## wrangler

Cloudflare's command-line tool. It reads its configuration from a `wrangler.jsonc` file (Worker
name, entry file, D1 database, variables, cron) and does:

| To… | Command |
|---|---|
| Test locally | `pnpm --dir worker dev` (needs `worker/.dev.vars`) |
| Create the tables locally | `pnpm --dir worker db:migrate:local` |
| Deploy an app | `pnpm --dir worker exec wrangler deploy --config ../deployments/<your-app>/wrangler.jsonc` |
| Validate without deploying | the same with `--dry-run` |
| Load a secret | `wrangler secret put <NAME>` (see below) |

Always with `pnpm`, never with `npx`. `--config` paths are relative to `worker/`.

## Variables and secrets per app

The same code serves several apps. Each app is configured with values that carry its name as a
suffix:

| Name | Type | Content |
|---|---|---|
| `HASH_PREFIX_<APP>` | variable | Hash prefix, for example `myapp-ban-v1` |
| `ENFORCE_<APP>` | variable | `"true"` blocks; any other value is observation mode |
| `APPLE_TEAM_ID_<APP>` | variable | Apple Team ID |
| `APPLE_KEY_ID_<APP>` | variable | Key ID of the DeviceCheck key |
| `APPLE_DC_KEY_P8_<APP>` | secret | Content of the `.p8` file |
| `ADMIN_TOKEN` | secret | CLI token (one per Worker, no suffix) |

- **Variables**: go in `vars` in `wrangler.jsonc`, in plain sight and in git.
- **Secrets**: encrypted in Cloudflare, never in git. They are loaded with `wrangler secret put`;
  the exact command is in the comment in `deployments/example/wrangler.jsonc`. Locally they go
  in `worker/.dev.vars` (outside git; there is a `.dev.vars.example`).
- The code reads both the same way: `env.<NAME>`.

`appConfig()` (`worker/src/env.ts`) assembles an app's configuration. The suffix is the `app`
field in uppercase, with `-` replaced by `_` (`myapp` ⇒ `_MYAPP`).

- Without `HASH_PREFIX_<APP>`, the app does not exist: `check` responds 404 and admin, 400
  `app not configured`.
- Without the three Apple values (Team ID, Key ID and `.p8`), it decides with D1 alone.

## workers.dev

The Cloudflare subdomain where a Worker is published when it isn't given a custom domain, in the
form `<worker-name>.<your-account-subdomain>.workers.dev`. The template declares no custom
domain, so a deployment named `nongrata-myapp` lives at
`https://nongrata-myapp.<your-subdomain>.workers.dev`. That URL, followed by
`/v1/device/check`, is what goes in `endpoint` when configuring the SDK.

## Purge Cron Trigger

A scheduled task, like a Unix cron job. In each deployment's `wrangler.jsonc`:

```jsonc
"triggers": { "crons": ["17 3 * * *"] }
```

Every day at 3:17 (UTC) Cloudflare calls `scheduled`, which deletes from `check_log` the rows
older than 30 days (`purgeCheckLog` in `worker/src/store.ts`). Nobody has to run it.

## Other configuration pieces

- **Rate limiting**: the `RATE_LIMITER` binding limits `check` to 20 requests per minute per IP;
  beyond that, `429`. Cloudflare accepted it on a free-plan account (2026-11-02).
- **Logs**: invocation logs are turned off (`invocation_logs: false`) so request bodies are not
  recorded.

## How the repo is split

```
worker/                     code shared by every app
├── src/                    the Worker
├── migrations/             D1 tables (used by every deployment)
└── wrangler.jsonc          for development and tests only (app "demo")
deployments/
├── example/wrangler.jsonc  template: name, D1 database, variables and cron
└── <your-app>/wrangler.jsonc your real deployment (ignored by git: contains your account's IDs)
```

Each app has **its own Worker** (`nongrata-myapp`) and **its own database**
(`nongrata-myapp`), but **the same code**: its `wrangler.jsonc` points to
`../../worker/src/index.ts` and to `../../worker/migrations`. A new app is a copy of
`deployments/example/` with its name, its variables and its secrets.

## Where it is in the code

- Routes, `fetch` and `scheduled`: `worker/src/index.ts`.
- Per-app configuration: `appConfig()` in `worker/src/env.ts`.
- All the SQL: `worker/src/store.ts`. Tables: `worker/migrations/0001_init.sql`.
- Deployment: template in `deployments/example/wrangler.jsonc`. Development and tests:
  `worker/wrangler.jsonc`.

Design: sections 3 (Cloudflare), 7 and 14 of [DESIGN.md](../DESIGN.md).
