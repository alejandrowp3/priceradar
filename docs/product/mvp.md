# PriceRadar — MVP Product Specification (`MVP 001`)

## 1. Product Vision

PriceRadar automatically explores permitted Colombian product catalogs (`es-CO`, `COP`), tracks price trajectories at the exact store + variant + city level, and surfaces high-signal shopping opportunities on a public read-only dashboard.

## 2. Core User Flows

1. **Automated Catalog Discovery (No Manual Watchlists):** Scheduled worker selects enabled `DiscoveryTarget` entries by priority and staleness, paginates through catalog listings, and normalizes variants.
2. **Transparent Opportunity Classification:**
   - `DECLARED_DISCOUNT` ("Descuento anunciado")
   - `HISTORICAL_DROP` ("Bajada de precio")
   - `HISTORICAL_LOW` ("Mínimo registrado")
   - `POTENTIAL_ANOMALY` ("Posible error de precio" — requires `>= 5` prior observations and `>= 45%` drop below historical median; never labeled a confirmed error).
3. **Public Portfolio Experience (Read-Only):**
   - `/` — Inicio (recent opportunities, anomalies, scan freshness, category highlights)
   - `/explorar` — Explorar ofertas (search, category/store/discount filters, provenance labels)
   - `/ofertas/[id]` — Detalle de oportunidad (price history chart, baseline stats, detection rationale, store link)
   - `/estadisticas` — Estadísticas (monitored coverage, observation counts, freshness)
   - `/como-funciona` — Cómo funciona (methodology, data limitations, demo vs live explanation)
4. **Private Administration (Server-Authorized):**
   - `/acceso`, `/admin`, `/admin/fuentes`, `/admin/ejecuciones`, `/admin/configuracion`

## 3. Data Provenance States

- `DEMO` — Displays visible badge `"Datos de demostración"`
- `LIVE` — Verified live provider observations
- `STALE` — Last successful scan exceeds freshness threshold
- `UNAVAILABLE` — Provider or storage temporarily unreachable
