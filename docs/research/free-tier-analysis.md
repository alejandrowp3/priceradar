# Free-Tier Infrastructure & Cost Model Analysis (USD $0/Month Target)

**Date:** 2026-11-07  
**Target Budget:** USD $0.00 / month  
**Target Components:** Neon PostgreSQL Free, Neon Auth (Managed Better Auth), Vercel Hobby, GitHub Actions (Public Repository)

---

## 1. Epistemic Boundary: Theoretical Estimates vs. Measured Usage

> [!IMPORTANT]
> **No cloud resources have been provisioned in Phase 0.**
> All compute, storage, and egress calculations in this document are **theoretical engineering projections** derived from official vendor quotas and mathematical modeling of PriceRadar's workload.
>
> **We do NOT claim that PriceRadar has been empirically verified to fit within free-tier quotas in production.** Empirical verification will only occur in Phase 2 and Phase 3 after database provisioning, real query telemetry, and scheduled execution measurements are collected.

| Dimension                                 | Status in Phase 0               | How It Will Be Measured in Phase 2/3                                         |
| ----------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| Published Vendor Quotas                   | **Verified from Official Docs** | N/A (Vendor policy)                                                          |
| Worker Active DB Duration per Scan        | **Theoretical Assumption**      | Measured via `scan_runs` execution timing and Neon Console `Consumption` tab |
| Neon Scale-to-Zero Idle Tail (`300 s`)    | **Documented Vendor Parameter** | Verified via Neon compute state transitions (`ACTIVE` -> `IDLE`)             |
| Row & Index Storage Byte Size             | **Theoretical Estimate**        | Measured via PostgreSQL `pg_total_relation_size()` on Neon                   |
| Website Visitor Traffic & Cache Hit Ratio | **Theoretical Scenario Model**  | Measured via Next.js cache headers and Neon active compute hours             |

---

## 2. Published Vendor Quotas (Neon PostgreSQL Free Tier)

From official Neon documentation:

- **Compute Allowance:** **100 CU-hours per project per month**.
  - Minimum compute size: `0.25 CU` (~1 GB RAM).
  - At a fixed `0.25 CU` size, `100 CU-hours` equals **400 active clock hours per month** (`100 / 0.25 = 400 hours`, out of `730 total hours` in an average 30.4-day month).
  - Default scale-to-zero suspension delay: **5 minutes (`300 seconds`) of inactivity**.
- **Storage Limit:** **1.0 GB (1,024 MiB) per project**.
- **Public Network Transfer (Egress):** **5 GB per month**.
- **Neon Auth (Managed Better Auth):** Up to **60,000 Monthly Active Users (MAUs)** free.

---

## 3. Recalculated Compute Model & Critical Sensitivity Analysis

### 3.1 Explicit Modeling Assumptions

1. **Compute Sizing (`CU`):** Pinned strictly to `0.25 CU` (min `0.25 CU`, max `0.25 CU`, autoscaling disabled so background scans never burst to `1–2 CU`).
2. **Autosuspend Window (`T_idle`):** `300 seconds` (`5.0 minutes`), the standard Neon Free tier scale-to-zero threshold after the last database connection closes.
3. **Active DB Query Time per Worker Scan (`T_db`):**
   - If the worker fetches external catalog data _first_ (taking `10–30 s` without opening a DB connection) and only opens a Neon connection at the end of the scan to read baselines and batch-insert observations/opportunities, active DB transaction time is estimated at **`T_db = 5 to 15 seconds`**.
   - Conversely, if the worker holds a DB connection open throughout a `45-second` crawl, `T_db = 45 seconds`.
4. **Total Active Compute Duration per Isolated Wakeup (`T_wake`):**
   $$T_{\text{wake}} = T_{\text{db}} + T_{\text{idle}}$$
   For `T_db = 15 s` and `T_idle = 300 s`, each isolated wakeup keeps the `0.25 CU` compute active for **`315 seconds` (`5.25 minutes` = `0.0875 hours`)**.

### 3.2 Scenario A — Naive 15-Minute DB Wakeups 24/7 (Every Scan Hits Neon)

- **Scheduled Frequency:** `4 scans/hour × 24 hours × 30.5 days = 2,928 scans/month` (assuming 100% GitHub Actions cron execution).
- **Worker-Driven Active Hours:**
  $$\text{Active Hours}_{\text{worker}} = 2,928 \times \frac{315\text{ s}}{3,600\text{ s/hr}} = 256.20\text{ active hours/month}$$
- **Worker-Driven Compute Units (`CU-hours` at `0.25 CU`):**
  $$\text{CU-hours}_{\text{worker}} = 256.20\text{ hours} \times 0.25\text{ CU} = 64.05\text{ CU-hours/month}$$
- **Remaining Headroom for Website Visitors & Admin:**
  $$100.00 - 64.05 = 35.95\text{ CU-hours/month} \quad (\approx 143.8\text{ active hours at } 0.25\text{ CU})$$
- **Risk Assessment for Scenario A:**
  - If public website visitors trigger uncached DB queries at random intervals between the 15-minute worker scans, the compute instance will rarely stay idle for 5 full minutes during daytime hours.
  - **Worst-Case Continuous Daytime Activity:** If visitor traffic keeps the `0.25 CU` compute awake continuously for 16 hours/day (`488 hours/month`) plus 8 hours/night of 15-minute worker wakeups (`85.4 hours/month`), total active time reaches **`573.4 hours/month` = `143.35 CU-hours/month`**, which **EXCEEDS the 100 CU-hour free limit by 43%** and would cause Neon to suspend compute before month-end.

### 3.3 Scenario B — Mitigated Architecture (Required to Stay Within 100 CU-Hours)

To prevent quota exhaustion under real usage, Phase 2 and Phase 3 must enforce three architectural controls:

1. **Aggressive Public Read Caching (Next.js ISR / Cache Tags):**
   - Public routes (`/`, `/explorar`, `/ofertas/[id]`, `/estadisticas`) must use server-side caching (`revalidate = 900` seconds / 15 minutes) so public visitors are served from Vercel's edge/data cache without waking Neon independently.
2. **Decoupled Worker Connection Window:**
   - The worker must only connect to Neon after external provider discovery finishes, executing all reads and writes in a single short connection window (`< 10 seconds`) and immediately closing the pool (`pool.end()`).
3. **Adaptive Scan Cadence / Nighttime Backoff (If Needed):**
   - Monitor cumulative `CU-hours` in Phase 3; if monthly usage trends above `80 CU-hours`, reduce off-peak overnight scan frequency (e.g., `01:00–05:00 COT`) or skip DB writes when provider etags/hashes indicate zero catalog changes.

| Scenario                                                            | Worker Scans / Mo |       Visitor DB Wakeups | Active Compute Hours / Mo | Monthly CU-Hours (`@ 0.25 CU`) | Fits 100 CU-hr Cap?    |
| ------------------------------------------------------------------- | ----------------: | -----------------------: | ------------------------: | -----------------------------: | ---------------------- |
| **1. Worst-Case (Uncached Web + 15m Worker + Autoscaling to 1 CU)** |             2,928 |                 Uncached |                  ~500 hrs |               **> 200 CU-hrs** | **NO (Fails ~Day 15)** |
| **2. Uncached Daytime Web + 15m Worker (`0.25 CU` pinned)**         |             2,928 |       Uncached (16h/day) |                 573.4 hrs |               **143.4 CU-hrs** | **NO (Fails ~Day 21)** |
| **3. Cached Web (15m ISR) + 15m Worker (`0.25 CU` pinned)**         |             2,928 | Piggybacks on 15m window |                 256.2 hrs |                **64.1 CU-hrs** | **YES (~36% margin)**  |
| **4. Cached Web + Change-Gated / Off-Peak Tuned Worker**            |            ~2,200 |     Piggybacks on window |                 192.5 hrs |                **48.1 CU-hrs** | **YES (~52% margin)**  |

---

## 4. Recalculated Storage Model (1.0 GB / 1,024 MiB Cap)

### 4.1 Explicit Row-Size & Volume Assumptions

- **PostgreSQL Heap + Tuple Header + B-Tree Index Overhead:**
  - `listings` row (including 3 indexes): **~600 bytes/row**
  - `price_observations` row (UUID PK, FK, `scan_run_id`, `idempotency_key` unique index, `listing_id + observed_at` composite index, integer prices, timestamps): **~380 bytes/row**
  - `opportunities` row (including 2 indexes): **~550 bytes/row**
  - `scan_runs` row: **~250 bytes/row**
- **Catalog Size Assumption:** `2,500 active listings` across monitored categories.
- **Scan Frequency:** `96 scans/day` (`2,928 scans/month`).

### 4.2 Unoptimized vs. Deduplicated Storage Growth

| Storage Strategy                                                |                               New `price_observations` Rows / Day |                        Monthly Storage Growth |                                                    6-Month Cumulative Storage | Fits 1 GB Cap?                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------: | --------------------------------------------: | ----------------------------------------------------------------------------: | ----------------------------------- |
| **Naive (Insert Every Observation on Every Scan)**              |                          `150 items × 96 scans = 14,400 rows/day` |                            `~167 MiB / month` |                                                              **`~1,002 MiB`** | **NO (Exhausts 1 GB in ~6 months)** |
| **Change-or-Daily-Heartbeat Deduplication + 90-Day Compaction** | `~2,500 heartbeat rows + ~250 price-change rows = 2,750 rows/day` | `~31.8 MiB / month` (capped at 90-day window) | **`~98 MiB steady-state`** (+ ~15 MiB catalog/rollups = **`~113 MiB total`**) | **YES (~11% of 1 GB cap)**          |

### 4.3 Mandatory Persistence Rules for Phase 2

1. **Change-or-Heartbeat Ingestion:** When the worker observes an unchanged price and availability for a listing within the same 24-hour UTC day, update `last_verified_at` on the latest observation and `last_observed_at` on `listings` rather than inserting a redundant row.
2. **90-Day Granular Retention:** Keep granular per-scan `price_observations` for 90 days; aggregate older history into daily min/median/max summaries.

---

## 5. Neon Auth, Vercel Hobby, and GitHub Actions Summary

- **Neon Auth (Managed Better Auth):** Public pages require zero authentication (`0 MAUs`). Admin access (`/acceso`, `/admin/*`) is restricted to `1` owner account (`<< 60,000 MAU` limit).
- **Vercel Hobby:** USD $0/month for personal, non-commercial use. Because Vercel Hobby restricts cron jobs to once per day, **Vercel Cron is not used**.
- **GitHub Actions:** Public repositories receive free standard runner minutes, subject to best-effort scheduling latency and automatic workflow disablement after 60 days of repository inactivity.
