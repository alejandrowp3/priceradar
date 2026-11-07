# ADR 003 — Integer Colombian Peso (`COP`) Monetary Arithmetic

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

IEEE 754 floating-point numbers introduce rounding inaccuracies in financial comparisons and percentage thresholds. Colombian retail pricing operates in whole Colombian Pesos (`COP`).

## Decision

1. Represent all monetary values as branded safe non-negative integers (`CopAmount`).
2. Reject floats, negative values, and `NaN` at runtime via `createCopAmount()` and Zod schemas.
3. Compute relative discounts in integer basis points (`1% = 100 bps`, `100% = 10,000 bps`) using integer arithmetic.
4. Format all display values with `Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 })`.

## Consequences

- Deterministic, reproducible price intelligence evaluations across worker and web runtimes.
