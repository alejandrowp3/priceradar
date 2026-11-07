# Local Development Guide

## 1. Prerequisites & Runtime Consistency (`F005`)

PriceRadar pins its Node.js and `pnpm` versions consistently across `.nvmrc`, `package.json`, and `.github/workflows/*.yml`:

- **Node.js:** `v24.21.0` (`>=24.0.0 <25.0.0` in `package.json` `engines.node`; read directly by GitHub Actions via `node-version-file: ".nvmrc"`).
- **Package Manager:** `pnpm@10.24.0` (`packageManager: "pnpm@10.24.0"` and `engines.pnpm: "10.24.0"` in `package.json`).
- **Local Machine NVM Note:** On this macOS development machine, `~/.nvm/versions/node` contains both `v25.9.0` (which does not include a `pnpm` binary) and `v24.21.0` (which includes `node v24.21.0` and `pnpm 10.24.0`). Always activate `v24.21.0` before running workspace commands:
  ```bash
  nvm use
  # Or explicitly prepend v24.21.0 to PATH in non-interactive shells:
  export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
  node --version  # v24.21.0
  pnpm --version  # 10.24.0
  ```
- **Git Identity Isolation:** This repository uses a repository-local Git identity (`alejandrowp3`) and SSH host alias (`github-personal`). Never modify global Git config or switch the active corporate `gh` CLI account.

Before running Git commands, verify:

```bash
git remote -v
git config --local user.name
git config --local user.email
```

---

## 2. Clean-Checkout Setup & Verification Sequence

From a fresh clone of the repository:

```bash
# 1. Activate the pinned Node 24.21.0 + pnpm 10.24.0 toolchain
nvm use

# 2. Install locked dependencies reproducibly
pnpm install --frozen-lockfile

# 3. Copy environment template (optional for Phase 0 DEMO mode)
cp .env.example .env.local

# 4. Verify port 4178 availability and policy compliance
pnpm check:port

# 5. Run code formatting check, ESLint, and strict TypeScript typechecking
pnpm format:check
pnpm lint
pnpm typecheck

# 6. Run unit and integration test suites (Vitest)
pnpm test

# 7. Execute the standalone automatic discovery CLI worker slice (no HTTP server)
pnpm worker:scan

# 8. Build the production Next.js web application and workspace packages
pnpm build

# 9. Start the local production server on http://127.0.0.1:4178 (or pnpm dev for development)
pnpm start
```

---

## 3. Port Isolation Policy (Port 4178)

PriceRadar strictly reserves **port `4178`** (`http://127.0.0.1:4178` / `http://localhost:4178`) for web development, local production preview, and Playwright E2E runs (`6178` for Storybook, `8178` for optional debugging).

- Forbidden ports (`3000`, `3001`, `3002`, `3100`, `3101`, `4000`, `5000`, `5173`, `8000`, `8080`) are never used.
- `scripts/check-port.mjs` runs automatically before `pnpm dev`, `pnpm start`, and `pnpm test:e2e`.
- If port `4178` is occupied, PriceRadar fails safely with exit code `1` without killing the existing process or choosing a fallback port.

---

## 4. Phase P1 — Supervised Rappi Browser Proof of Concept (`pnpm rappi:inspect`)

To validate single-storefront DOM extraction, keyed HMAC-SHA256 geographic context privacy (`ctx-<16hex>`, `F-P1-01`), 5-layer fulfillment-context validation (`F-P1-02`), and `LIVE_PRIVATE` opportunity classification without touching the corporate browser profile:

```bash
# 1. Interactive supervised mode on an authorized personal machine:
#    Automatically provisions/reuses ~/.local/share/priceradar/context-hmac.key (0600)
#    and ~/.local/share/priceradar/chromium-profile (0700):
pnpm rappi:inspect -- --persist-authorized-personal-profile

# 2. Ephemeral interactive mode (default — zero files persisted on disk; requires PRICERADAR_CONTEXT_HMAC_SECRET in env):
PRICERADAR_CONTEXT_HMAC_SECRET="$(openssl rand -hex 32)" pnpm rappi:inspect

# 3. Controlled supervised session simulation (all 5 fulfillment-context layers verified):
pnpm rappi:inspect -- --simulate-controlled-session

# 4. Controlled simulation of an active delivery header with unverified static SEO catalog (rejected by F-P1-02):
pnpm rappi:inspect -- --simulate-unverified-header-only
```

---

## 5. Phase P2 — Private Price History & Deal Detection (`pnpm history:cli`)

Phase P2 persists eligible supervised Rappi storefront observations locally in SQLite (`~/.local/share/priceradar/private-history.sqlite`, directory `0700`, file `0600`, strictly outside the Git repository) after explicit owner confirmation.

### 5.1 Supervised Inspection with Preview or Consent-Gated Persistence

```bash
# 1. Preview how an observed storefront compares against local SQLite history (read-only, 0 writes):
pnpm rappi:inspect -- --persist-authorized-personal-profile --preview-history

# 2. Inspect and prompt for explicit owner consent ('SI') before persisting to SQLite:
pnpm rappi:inspect -- --persist-authorized-personal-profile --save
```

### 5.2 Private History Inspection CLI Commands

```bash
# Database status, permissions, schema version, and row counts:
pnpm history:cli status

# Recent supervised observation runs:
pnpm history:cli runs

# Chronological price history for a specific product ID, variant ID, or product name:
pnpm history:cli product "Aceite de Oliva"

# Active historical price drops and all-time lows (HISTORICAL_LOW, HISTORICAL_DROP):
pnpm history:cli drops

# Active potential pricing anomalies and declared discounts requiring manual verification:
pnpm history:cli anomalies
```

### 5.3 Crash Recovery, Historical Corrections, and Local Backup / Restore

1. **Atomic Batch Transactions & Crash Recovery:**
   - Every batch save (`persistApprovedInspectionBatch`) executes inside a single `BEGIN IMMEDIATE ... COMMIT` SQLite WAL transaction covering `fulfillment_contexts`, `stores`, `scan_runs`, `products`, `price_observations`, and `opportunity_events`.
   - If the process crashes or throws an error between observation insertion and opportunity creation, SQLite automatically rolls back the entire transaction on the next connection open (`0` partial rows or orphaned opportunities).
2. **Non-Destructive Historical Corrections:**
   - Wrong or anomalous historical observations are corrected via `markObservationSuperseded(observationId, reason)`, which sets `is_superseded = 1` and transitions any linked `ACTIVE` opportunity events to `SUPERSEDED` without destructively rewriting audit history.
3. **Local Backup & Restore Procedure:**
   - Always keep backups outside the Git repository with `0600` permissions:
     ```bash
     # Create an online consistent backup using SQLite's backup API:
     sqlite3 "$HOME/.local/share/priceradar/private-history.sqlite" \
       ".backup '$HOME/.local/share/priceradar/private-history.sqlite.bak'"
     chmod 600 "$HOME/.local/share/priceradar/private-history.sqlite.bak"

     # Restore from backup if needed:
     cp -p "$HOME/.local/share/priceradar/private-history.sqlite.bak" \
       "$HOME/.local/share/priceradar/private-history.sqlite"
     chmod 600 "$HOME/.local/share/priceradar/private-history.sqlite"
     ```
