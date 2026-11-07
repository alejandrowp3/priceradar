# ADR 002 — Mandatory Local Port Isolation Policy (Port 4178)

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

The developer machine hosts multiple concurrent engineering projects. Standard framework ports (`3000`, `3001`, `5173`, `8000`, `8080`, etc.) risk colliding with active corporate or personal services, or causing Playwright E2E runners to attach to an unrelated server.

## Decision

1. Reserve port `4178` (`127.0.0.1:4178`) exclusively for PriceRadar Next.js development, local production preview, and Playwright E2E tests (`6178` for Storybook, `8178` for debugging).
2. Explicitly pass `-p 4178 -H 127.0.0.1` to `next dev` and `next start`.
3. Enforce `scripts/check-port.mjs` before starting web servers or E2E suites.
4. Never terminate occupying processes or fall back to another port automatically.

## Consequences

- Zero interference with other local projects.
- Deterministic failure with actionable diagnostics if port `4178` is already bound.
