# PriceRadar Colombia

**Automated Price Intelligence Platform (`es-CO` · Integer `COP`) — Portfolio Engineering Project (`MVP 001`)**

PriceRadar is a personal, non-commercial full-stack engineering project designed to automatically explore permitted Colombian product catalogs, normalize store and packaging variants, track historical prices in integer Colombian Pesos (`COP`), and surface verified price drops and potential pricing anomalies.

---

## Current Implementation Status

- **Current Phase:** **Phase 0 + Phase P1 Completed** (Foundation, Feasibility Research, Monorepo Architecture, Port Isolation, Domain Contracts, Deterministic Price Intelligence Engine, `FixtureCatalogProvider`, Standalone Discovery Worker, Experimental Manual Supervised Rappi Browser Inspector with Keyed HMAC Privacy & Geographic Provenance Validation, Unit/Integration Test Suite, and CI Pipeline).
- **Data Mode:** `DEMO` (`FixtureCatalogProvider` — all public demo observations are explicitly badged `"Datos de demostración"`).
- **Experimental Rappi Browser Inspector (`pnpm rappi:inspect`):** Strictly manual, read-only, and owner-supervised in a visible Chromium window. **Unattended automated Rappi monitoring is NOT operational and remains disabled.**
- **External Provisioning:** No external services (Neon PostgreSQL, Vercel) are provisioned in Phase 0 / P1.

---

## Core Engineering Highlights

1. **Automatic Catalog Discovery (Not Manual Watchlists):**
   - `@priceradar/worker` executes as a bounded, standalone CLI process (no persistent HTTP server) that selects enabled `DiscoveryTarget` entries by priority, paginates with cursor checkpoints, and persists observations idempotently.
2. **Deterministic Price Intelligence in Integer `COP`:**
   - `@priceradar/domain` enforces branded safe non-negative integers (`CopAmount`) and basis-point discount math (`1% = 100 bps`), eliminating floating-point inaccuracies.
   - Classifies four distinct opportunity types in Colombian Spanish (`es-CO`):
     - `DECLARED_DISCOUNT` (_"Descuento anunciado"_)
     - `HISTORICAL_DROP` (_"Bajada de precio"_)
     - `HISTORICAL_LOW` (_"Mínimo registrado"_)
     - `POTENTIAL_ANOMALY` (_"Posible error de precio"_ — requires `>= 5` prior observations and `>= 45%` drop below the historical median; never treated as a confirmed error automatically).
   - Strictly excludes current observations from historical baselines and prevents merging distinct variants (`250 g` vs `500 g`) or stores.
3. **Strict Local Port Isolation (Port `4178`):**
   - Web development, local production preview, and Playwright E2E tests are pinned to `http://127.0.0.1:4178` (`next dev -p 4178 -H 127.0.0.1` and `next start -p 4178 -H 127.0.0.1`).
   - `scripts/check-port.mjs` verifies port availability before server startup, rejects forbidden ports (`3000`, `3001`, `5173`, `8000`, `8080`, etc.), never kills existing processes, and never silently falls back to another port.

---

## Repository Structure

```text
priceradar/
├── apps/
│   ├── web/                # Next.js 15 App Router web application (pinned to port 4178)
│   └── worker/             # Standalone CLI discovery & price intelligence worker
├── packages/
│   ├── config/             # Shared port policy & runtime configuration bounds
│   ├── domain/             # Integer COP money math, entities, es-CO strings, intelligence rules
│   ├── providers/          # Capability-aware CatalogProvider contract & FixtureCatalogProvider
│   ├── database/           # Normalized repository interfaces & in-memory storage adapter
│   └── ui/                 # Design system tokens (dark/light themes)
├── scripts/
│   ├── check-port.mjs      # Safe port 4178 preflight utility
│   └── check-port.test.ts  # Automated port policy & collision tests
├── docs/
│   ├── architecture/       # System overview & normalized PostgreSQL data model
│   ├── decisions/          # Architecture Decision Records (ADRs 001–003)
│   ├── product/            # MVP specification & visual design system
│   ├── research/           # Provider feasibility & free-tier quota analysis
│   └── operations/         # Local development, deployment, and monitoring guides
└── .github/workflows/      # SHA-pinned CI and 15-minute discovery workflow (inactive in Phase 0)
```

---

## Getting Started (Clean Checkout)

### Prerequisites

- **Node.js:** `v24.21.0` (pinned in `.nvmrc`, `package.json` `engines`, and GitHub Actions `node-version-file: ".nvmrc"`)
- **pnpm:** `10.24.0` (pinned in `package.json` `packageManager` and `engines`)

### Installation & Verification

```bash
# 0. Activate Node v24.21.0 (if using nvm)
nvm use

# 1. Install workspace dependencies from lockfile
pnpm install --frozen-lockfile

# 2. Run the port 4178 preflight check
pnpm check:port

# 3. Run format check, lint, strict TypeScript typecheck, and unit/integration tests
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test

# 4. Execute an end-to-end discovery-to-analysis vertical slice via the CLI worker
pnpm worker:scan

# 5. Build and start the Next.js application on http://127.0.0.1:4178
pnpm build
pnpm start
```

---

## Provider Constraints & Demo Mode

- **Rappi Colombia Feasibility Verdict (Multi-Mode Assessment):**
  - **Public Republication of Live Data:** **`BLOCKED`** (Consumer ToS grants personal, non-commercial use only and reserves all IP/database rights).
  - **Automated Headless Browser on GitHub Actions:** **`BLOCKED`** (Cannot support manual owner login, exposes session tokens to cloud runners, and triggers datacenter IP/WAF mismatches).
  - **Owner-Authenticated Headed Browser Observation (Personal Saved Address):** **`CONDITIONAL GO`** (Technically capable of reading address-scoped product cards, integer `COP` prices, packaging, and stock from the rendered DOM after manual owner login; conditioned on keeping profiles outside Git, stripping street-level PII, never bypassing CAPTCHAs/WAF, not running unattended background automation on the corporate Mac, and keeping all observations strictly `LIVE_PRIVATE`).
  - **Public Pre-Rendered Storefront HTML (`/tiendas/tipo/market`, `/tiendas/{slug}`):** **`CONDITIONAL GO`** (Exposes ~105 initial products per store branch in SSR state without `/api*` calls, anchored to static city/neighborhood coordinates such as `Medellín — El Poblado`). See [`docs/research/provider-feasibility.md`](docs/research/provider-feasibility.md).
- **Public Portfolio Demo Mode (`DEMO`):** The public unauthenticated dashboard and automated tests use `FixtureCatalogProvider` (`fixture-colombia`), which provides deterministic multi-store, multi-variant Colombian product catalogs and reproducible price anomalies explicitly labeled `"Datos de demostración"`.

---

## Planned Infrastructure & Security Model

- **Database (Phase 2):** Neon PostgreSQL Free Tier (1 GB storage, 100 CU-hours/month) with Drizzle ORM and change-or-heartbeat observation deduplication.
- **Authentication (Phase 2):** Neon Auth (Managed Better Auth) protecting `/admin/*` server-side while keeping public dashboard pages read-only and unauthenticated.
- **Scheduling (Phase 3):** GitHub Actions (`cron: "7,22,37,52 * * * *"`), currently disabled until Phase 3 authorization.
- **Hosting (Phase 5):** Vercel Hobby (personal, non-commercial project isolated from any other deployments).
- **Security:** See [`SECURITY.md`](SECURITY.md) and [`docs/research/free-tier-analysis.md`](docs/research/free-tier-analysis.md).

---

## Implementation Roadmap

- [x] **Phase 0:** Foundation, provider/free-tier feasibility, port 4178 isolation, domain contracts, `FixtureCatalogProvider`, standalone worker vertical slice, unit/integration tests, and CI.
- [ ] **Phase 1:** Public UI, editorial design system, dark/light themes, `es-CO` localization, `/explorar`, `/ofertas/[id]`, Recharts price history, and demo badges.
- [ ] **Phase 2:** Neon PostgreSQL Drizzle schema migrations, persistence layer, Neon Auth, and server-side `/admin/*` authorization.
- [ ] **Phase 3:** Compliant provider integration, target rotation, idempotent database ingestion, and scheduled GitHub Actions activation.
- [ ] **Phase 4:** Advanced price intelligence, opportunity ranking, confidence scoring, and alert lifecycle.
- [ ] **Phase 5:** Independent Vercel deployment, SEO/Open Graph, WCAG 2.2 AA accessibility audit, and Playwright E2E verification.

---

## Licensing Notice

All rights reserved unless an explicit open-source license is approved and added by the repository owner (`alejandrowp3`). Public repository visibility does not grant a license to redistribute or commercialize.
