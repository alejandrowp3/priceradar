# PriceRadar P5 — Cloud-First Architecture & Deployment Specification

## 1. Executive Summary & Hard Requirements

As clarified by the repository owner, **PriceRadar must be hosted in the cloud from the first deployable increment**. Local Docker prototyping, local scheduler execution, and local browser dependencies are explicitly deprecated for operational monitoring.

### Non-Negotiable Operational Invariants

1. **Zero Local Docker**: No Docker installation required on the owner's personal computer.
2. **Zero Local Chromium**: Normal continuous operations run entirely headlessly in cloud infrastructure.
3. **Zero Local Scheduler / Worker**: Routine price monitoring never depends on local background processes.
4. **Zero Desktop Uptime Requirement**: The owner's Mac does not need to remain powered on.
5. **Zero Localhost Dependency**: The dashboard and API are accessed over private HTTPS on the public internet.
6. **Zero Manual Monitoring Commands**: Routine catalog collection runs automatically on schedule in the cloud.
7. **Cloud Persistence**: Storage, history, and scheduled execution reside in durable cloud infrastructure.
8. **Private Remote Access**: The dashboard is secured with encrypted HTTPS and mandatory authentication.
9. **Remote Session Recovery**: Session provisioning and maintenance are operable remotely without defeating access controls.
10. **GitHub-Driven Reproducibility**: Deployments build and deploy automatically from GitHub commits.

---

## 2. Cloud Platform Evaluation & Selection

| Evaluation Criteria        | **Railway (Selected Primary)**                  | **Render (Alternative)**                                | **Fly.io (Alternative)**       | **Hetzner Cloud VPS (Self-Hosted)** |
| :------------------------- | :---------------------------------------------- | :------------------------------------------------------ | :----------------------------- | :---------------------------------- |
| **Build Source**           | Direct GitHub webhook build                     | Direct GitHub webhook build                             | GitHub Actions / flyctl        | Manual git pull / CI pipeline       |
| **Local Docker Needed?**   | **No** (Cloud Docker builder)                   | **No** (Cloud Docker builder)                           | **No** (Remote Docker builder) | No                                  |
| **Persistent Volume**      | **Yes** (`/data`, 5 GB SSD)                     | **Yes** (`/data`, 5 GB SSD)                             | **Yes** (`/data`, 5 GB SSD)    | Yes (Local NVMe)                    |
| **Unified SQLite Support** | **Optimal** (Single container for Web + Worker) | **Limited** (Disks non-shared; cron cannot mount disks) | Supported per machine          | Supported on host                   |
| **Playwright Chromium**    | Supported (1–2 GB RAM active)                   | Supported (Standard tier 2 GB)                          | Supported (2 GB RAM)           | Supported (4 GB RAM)                |
| **Encrypted Secrets**      | Native Web UI / CLI                             | Native Web UI / CLI                                     | Native Web UI / CLI            | Environment files (.env)            |
| **Auto HTTPS & Domains**   | Automatic Let's Encrypt                         | Automatic Let's Encrypt                                 | Automatic Let's Encrypt        | Requires Caddy / Certbot setup      |
| **Healthcheck Probes**     | Native (`/api/health`)                          | Native (`/api/health`)                                  | Native (`/api/health`)         | Custom systemd / monitoring         |
| **Maintenance Burden**     | **Zero OS sysadmin**                            | **Zero OS sysadmin**                                    | **Zero OS sysadmin**           | High (Linux updates, firewall, SSL) |
| **Monthly Cost**           | **$8.00 – $12.00 / mo**                         | **$25.00+ / mo**                                        | **$10.00 – $15.00 / mo**       | **€3.79 (~$4.10) / mo**             |

### Selected Provider Justification: Railway

1. **Unified Container Lifecycle for SQLite Integrity**:
   Because SQLite is an embedded single-file database, hosting Next.js Web Dashboard and Cloud Worker in separate microservice containers across a network share would introduce severe file locking (WAL lock contention), NFS latency, and risk database corruption. Railway enables a **single-service container architecture** where both Next.js and the background scheduler run in the same container, sharing `/data/private-history.sqlite` locally at bare-metal speeds with atomic WAL semantics.
2. **Cost-Efficiency & Compute Scaling**:
   Railway charges based on actual resource utilization: $5.00 platform credit + RAM ($0.000231/GB-hr) + vCPU + Disk ($0.25/GB/mo). Running a 1–2 GB container costs **~$8–$12/month**, compared to Render which forces a $25/month tier to get the 2 GB RAM required by Playwright Chromium.
3. **No VPS Overhead**:
   Managed platform with automatic HTTPS, zero OS patching, zero reverse-proxy maintenance, and native GitHub deployment hooks.

---

## 3. Database Persistence & Isolation Model

- **Engine**: SQLite 3 with Write-Ahead Logging (`PRAGMA journal_mode=WAL;`).
- **Location**: `/data/private-history.sqlite` on a dedicated 5 GB persistent SSD volume mounted at `/data`.
- **Repository Isolation**: `/data` is outside `/app` (the Git repository root), satisfying `assertDatabasePathOutsideRepository()`.
- **Storage Readiness & Persistent Contract (`F7-08`, `F7-11`, `F7-11A`, `F7-11B`)**:
  - The system explicitly distinguishes a writable filesystem from a verified persistent volume (`F7-11`). Dockerfile `VOLUME ["/data"]` alone is not proof of durable cloud storage.
  - **Mount Path Validation (`F7-11A`)**: In Railway mode, `RAILWAY_VOLUME_MOUNT_PATH` (e.g. `/data`) is validated against the configured SQLite storage directory. The storage path must match or be contained within the platform-injected mount path. Arbitrary volume-name environment declarations without verified mount paths are rejected.
  - **CI Confinement (`F7-11A`)**: `PRICERADAR_PERSISTENCE_TIER="SIMULATED_CI_VOLUME"` is strictly restricted to automated CI and test environments (`CI=true` / `NODE_ENV=test`); setting this tier in cloud production fails closed.
  - **Platform Evidence vs. Restart Proof (`F7-11A`)**: The system distinguishes platform configuration evidence (`evidenceType: "RAILWAY_PLATFORM_MOUNT"`) from persistence verified by restart testing (`restartProofVerified: true`).
  - **Fail-Closed Volume Marker Protocol (`F7-11B`)**:
    - Atomic volume markers (`.priceradar-volume-marker.json`) are written upon volume mount to establish stable volume identity across container restarts and replacements.
    - If marker creation or write fails, the system fails closed with HTTP 503 instead of reporting success.
    - Existing markers are validated before trust (checking `volumeId`, `createdAt`, `storagePath`, and `persistenceTier`). Corrupted or incomplete markers fail closed and are never silently overwritten.
    - **Marker Recovery Procedure**: If a marker becomes corrupted due to hardware anomalies, an authorized operator can safely remove or regenerate the `.priceradar-volume-marker.json` file on the persistent volume after confirming SQLite file integrity.
  - The readiness probe distinguishes first-time initialization (mounted and writable volume before the initial scan has executed) from an unmounted or inaccessible volume.
  - When the database file exists, read integrity and schema readiness are verified before reporting healthy.
- **Concurrency Model & Distributed Lease Locks (`F7-06`, `F7-09`)**:
  - `railway.json` sets `numReplicas: 1` ensuring a single active container instance.
  - Next.js Server Components instantiate `SqlitePrivateHistoryRepository` in strict read-only mode (`{ readOnly: true }`).
  - The in-process `CloudScheduler` acquires an atomic worker lease lock (`acquireWorkerLock`) before starting a scan run.
  - Long scans actively renew the lease (`renewWorkerLock`) on a periodic interval.
  - `persistApprovedInspectionBatch` enforces `requiredWorkerLock` both before initiating mutations and immediately before committing the transaction; if lock ownership was lost or expired, the transaction is atomically rolled back to prevent split-brain writes.
  - WAL mode guarantees concurrent reads never block writes and writes never block reads.
- **Snapshot Backups**: The worker can automatically copy `/data/private-history.sqlite` to `/data/backups/` periodically.

---

## 4. Remote Dashboard Access & Security Architecture

1. **DNS Rebinding & Host Validation (`F7-01`, `F7-07`)**:
   - `apps/web/src/middleware.ts` validates incoming `Host` headers against `PRICERADAR_ALLOWED_HOSTS` (e.g. `*.railway.app`, `priceradar-production.up.railway.app`).
   - In cloud mode (`PRICERADAR_ENV=cloud` or `NODE_ENV=production`), client-provided loopback `Host` headers (such as `Host: 127.0.0.1:4178` or `Host: localhost:4178`) are never trusted to establish local loopback privileges.
   - Passwordless access is strictly forbidden in cloud deployments and is limited to verified loopback-bound servers in local development.
   - Unauthorized host headers are rejected with HTTP 403.
2. **Mandatory Remote Authentication (`F7-01`, `F7-07`)**:
   - Configured via `PRICERADAR_WEB_PASSWORD`.
   - In cloud mode, authentication fails closed: missing, empty, or whitespace-only password configuration results in HTTP 401 on all protected routes and prevents cloud startup.
   - When configured, requests must supply valid HTTP Basic Auth credentials (`Authorization: Basic <base64>`).
   - Unauthenticated requests receive HTTP 401 with `WWW-Authenticate: Basic realm="PriceRadar Private Dashboard"`, prompting the browser's native login modal.
3. **Platform Health Check & Positive Scheduler Evidence (`F7-02`, `F7-08`, `F7-10`, `F7-11`)**:
   - `/api/health` is exempt from Basic Auth and provides a minimal public readiness probe (`{"status":"healthy","ready":true}`). It exposes zero filesystem paths, database names, fulfillment hashes, or scheduler timestamps.
   - **Positive Evidence Requirement (`F7-10`)**: In cloud mode, `/api/health` strictly requires positive evidence of an active scheduler with a fresh heartbeat. It fails closed (HTTP 503) if the scheduler is stopped (`isRunning: false`), if the status file is missing or unparseable after the startup grace window, or if the heartbeat timestamp is stale (`> 90s`) or future-dated (`> 5s`).
   - **Startup Window & Deadlock Prevention (`F7-10`)**: Genuine initial startup (`isFirstTimeInit: true` on verified storage with an active scheduler running its initial collection cycle with `totalScansExecuted: 0`) reports healthy (HTTP 200) to prevent deployment readiness deadlocks while remaining fail-closed against unverified or dead processes.
   - `/api/telemetry` provides detailed operational KPIs (including persistence tier, volume marker, scheduler heartbeat age, and scan run history) and requires full authentication.

---

## 5. Remote Session Initialization & Recovery for Rappi Turbo

### The Operational Challenge

Rappi Turbo requires an authenticated delivery profile, address selection, and session tokens. In cloud infrastructure:

- The worker runs headlessly without a local macOS graphical desktop.
- The worker must **never** attempt to defeat security challenges, CAPTCHAs, or SMS/OTP gates.

### Approved Remote Session Workflows

#### Workflow A: Authorized Session Sync CLI (`pnpm cloud:session-sync`) — Primary

1. The owner performs the interactive login once locally on their Mac using:
   ```bash
   pnpm rappi:inspect --persist-authorized-personal-profile
   ```
2. The browser cookies, local storage, and address context are stored locally in `~/.local/share/priceradar/rappi-profile/`.
3. The owner executes a secure sync command:
   ```bash
   pnpm cloud:session-sync --url https://<railway-domain> --secret <PRICERADAR_AUTH_SECRET>
   ```
4. The local tool encrypts the session state with `PRICERADAR_AUTH_SECRET` and uploads it over HTTPS to the cloud container's persistent storage `/data/rappi-session/`.
5. The cloud worker loads this authenticated storage state for scheduled headless runs.

#### Workflow B: Interactive Web Stream / Remote CDP — Recovery

1. When session renewal or re-authentication is required in the cloud, the owner logs into the private dashboard and navigates to `/system/session-login`.
2. The container opens a secure, authenticated interactive session stream (e.g. Playwright CDP over authenticated WebSocket or noVNC stream) in an iframe.
3. The owner enters their phone number, receives the SMS OTP on their phone, manually inputs the code, and confirms the active delivery address.
4. The cloud worker saves the refreshed session to `/data/rappi-session/` and resumes automated monitoring.

---

## 6. First Cloud Milestone (Vertical Slice Verification)

The initial deployment increment achieves:

1. **Cloud-Hosted Private Dashboard**: Next.js 15 dashboard live on HTTPS with HTTP Basic Auth and security headers.
2. **Cloud-Hosted Scheduler & Worker**: In-process `CloudScheduler` running every 60 minutes.
3. **Durable Price History**: Persistent SQLite database stored at `/data/private-history.sqlite`.
4. **Deterministic Test Collector**: `FixtureCatalogProvider` executes scheduled scans, discovering items, calculating price drops, and persisting observations without third-party network flakiness.
5. **Telemetry & Execution History**:
   - `/system` page displaying real-time infrastructure KPIs, scheduler state, and scan run history table.
   - Minimal unauthenticated `/api/health` probe and authenticated `/api/telemetry` operational endpoint.

---

## 7. Remaining Blockers Before Live Rappi Turbo Monitoring

1. **Remote Session State Sync**: Completing Workflow A (`pnpm cloud:session-sync`) so the cloud worker has the owner's authorized delivery address and session cookies without manual intervention in the container.
2. **Datacenter Geo-IP Routing Verification**: Cloud servers in US-East or generic cloud regions must be tested to confirm whether Rappi Turbo API routes catalog availability based on the address context or if cloud IPs trigger Cloudflare/WAF challenges. If WAF blocks datacenter IPs, an egress proxy (e.g., Colombian proxy or residential tunnel) will be configured.
3. **Explicit Owner Approval for Live Data**: Live credentials and personal addresses will only be synchronized after the owner verifies the cloud dashboard on Milestone 1.

---

## 8. Remaining Limitations Specific to Railway Deployment

1. **Single-Service Volume Attachment**: Railway persistent volumes attach exclusively to a single service instance (`numReplicas: 1`). They cannot be mounted simultaneously across multiple independent Railway services, which matches PriceRadar's unified container architecture where Next.js server components and the background scheduler run co-located, sharing `/data/private-history.sqlite`.
2. **Single-Region Bound**: Railway volumes are provisioned within a specific Railway datacenter region. Relocating a deployment to a different region requires creating a new volume and transferring the SQLite database snapshot.
3. **Rolling Deployment Handover**: During deployment updates, Railway gracefully stops the previous container and boots the new replacement container mounting the exact same persistent disk. PriceRadar's atomic worker lease lock, pre-commit lock validation, and volume marker verification ensure seamless, corruption-free handovers across replacements.
