# ADR 001 — Provider Adapter Strategy & Authenticated Browser Feasibility

- **Status:** Accepted (Updated with Authenticated Browser Assessment on 2026-11-07)
- **Date:** 2026-11-07

## Context

PriceRadar is a personal, non-commercial tool designed to automate the owner's discount-checking routine for their saved delivery address in Colombia (`es-CO`, integer `COP`), while exposing a public portfolio dashboard powered by deterministic demo data (`DEMO_FIXTURE`).

We evaluated three technical modes for Rappi Colombia:

1. **Unauthenticated Arbitrary Routes (`/bogota/supermercados`):** Returned `HTTP 404` (`BLOCKED`), and `robots.txt` disallows `/api`, `/api-services`, and `/base-api`.
2. **Unauthenticated Pre-Rendered SSG Storefronts (`/tiendas/tipo/market`, `/tiendas/900129753-turbo-super`):** Returned `HTTP 200` with `105` products and `Medellín — El Poblado` metadata (`CONDITIONAL GO`), but only reflect static SEO store branches rather than the owner's exact saved delivery address.
3. **Owner-Authenticated Headed Playwright Browser Session:** A visible Chromium browser where the owner manually logs in and selects their saved delivery address renders address-accurate store inventory, integer `COP` prices, reference discounts, packaging, and availability in the DOM (`CONDITIONAL GO` for supervised personal use; `BLOCKED` on GitHub Actions and `BLOCKED` for public data republication).

## Decision

1. **Public Portfolio & Automated CI (`GO` with `FixtureCatalogProvider`):** All public pages (`/`, `/explorar`, `/ofertas/[id]`, `/estadisticas`) and GitHub Actions workflows use `FixtureCatalogProvider` (`DEMO_FIXTURE`, labeled `"Datos de demostración"`).
2. **Browser-Assisted Personal Workflow (`CONDITIONAL GO` — On-Demand / Supervised Only):**
   - Never request, log, or store Rappi passwords, cookies, or personal street addresses.
   - Store any Chromium profile strictly outside the repository (`~/.local/share/priceradar/chromium-profile`, mode `0700`) and block `.playwright-profile/`, `.auth/`, `*.har`, and `*storage-state*.json` in `.gitignore`.
   - Never run authenticated personal browser sessions on GitHub Actions (`BLOCKED`) or as unattended background daemons on the corporate Mac.
   - Keep all real observations strictly private (`LIVE_PRIVATE`, accessible only to the authenticated owner).

## Consequences

- Preserves strict credential security, corporate machine isolation, and contractual compliance while defining a realistic, owner-supervised path for address-specific personal price checks.
