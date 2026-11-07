# Operational Monitoring & Scheduled Worker Reliability

## 1. Structured Worker Telemetry

`@priceradar/worker` emits structured JSON scan summaries (`ScanRunRecord`) reporting:

- `scanRunId`, `startedAt`, `completedAt`
- `status`: `'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'SKIPPED_LOCKED'`
- `targetsAttempted`, `targetsCompleted`
- `listingsDiscovered`, `observationsPersisted`, `opportunitiesCreated`
- `isPartialCoverage` (honest indicator when bounded by `maxProductsPerScan` or pagination)

## 2. Concurrency & Overlap Protection

- **GitHub Actions Level:** `concurrency: { group: priceradar-discovery-worker, cancel-in-progress: false }` ensures queued workflow runs never cancel an active scan mid-flight or run concurrently.
- **Application/Database Level:** `acquireWorkerLock` with a bounded TTL (`240,000 ms`) prevents overlapping executions even if triggered simultaneously via CLI and workflow dispatch.

## 3. GitHub Actions 60-Day Inactivity Behavior

In public GitHub repositories, scheduled workflows (`on.schedule`) are automatically disabled by GitHub if no repository activity occurs for **60 consecutive days**.

- PriceRadar documents this limitation transparently.
- **Policy:** Never use automated dummy commits or bot keep-alive commits to artificially reset the 60-day timer. If disabled due to inactivity, the repository owner can re-enable the workflow manually in the GitHub Actions tab or via `workflow_dispatch`.
