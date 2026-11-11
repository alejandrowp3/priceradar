# PriceRadar P5 — Cloud Deployment Guide

This guide describes how to deploy PriceRadar to **Railway** in under 5 minutes directly from GitHub.

**Prerequisites:**

- Zero local Docker installation required.
- Zero local build commands needed.
- A GitHub account with access to `alejandrowp3/priceradar`.
- A free Railway account (https://railway.com).

---

## Step 1: Create a New Project on Railway

1. Open your browser and log into [Railway Dashboard](https://railway.com/dashboard).
2. Click **+ New Project** -> Select **Deploy from GitHub repo**.
3. Choose the repository `alejandrowp3/priceradar`.
4. Railway will automatically detect the `Dockerfile` and `railway.json` at the root of the repository, applying `numReplicas: 1` and the configured `/api/health` healthcheck probe.

---

## Step 2: Add a Persistent Volume for SQLite

1. In the project canvas, click on your PriceRadar service.
2. Select the **Volumes** tab.
3. Click **+ Add Volume**.
4. Set the **Mount Path** to:
   ```text
   /data
   ```
5. Set the size to **5 GB** (SSD).
6. Click **Save**.

---

## Step 3: Configure Environment Variables

In the **Variables** tab of your service, add the following variables:

| Variable                               | Recommended Value                | Purpose                                        |
| :------------------------------------- | :------------------------------- | :--------------------------------------------- |
| `NODE_ENV`                             | `production`                     | Enables production optimizations               |
| `PRICERADAR_ENV`                       | `cloud`                          | Bypasses local desktop port constraints        |
| `PRICERADAR_SQLITE_PATH`               | `/data/private-history.sqlite`   | Points SQLite to the persistent volume mount   |
| `PRICERADAR_SCHEDULE_INTERVAL_MINUTES` | `60`                             | Background scan frequency (minutes)            |
| `PRICERADAR_SCAN_ON_STARTUP`           | `true`                           | Runs an initial collection cycle on boot       |
| `PRICERADAR_WEB_PASSWORD`              | `<your-private-password>`        | Secures dashboard access with HTTP Basic Auth  |
| `PRICERADAR_ALLOWED_HOSTS`             | `*.railway.app,*.up.railway.app` | Allows your Railway HTTPS domain               |
| `PRICERADAR_AUTH_SECRET`               | `<random-64-character-hex>`      | Cryptographic secret for session authorization |
| `PRICERADAR_HMAC_SECRET`               | `<random-64-character-hex>`      | Fulfillment context HMAC hashing secret        |

_(Railway automatically provides `PORT` and routes public traffic to it)._

---

## Step 4: Generate Public HTTPS Domain

1. In the service **Settings** tab, scroll to **Networking** -> **Public Networking**.
2. Click **Generate Domain**.
3. Railway will provision an SSL certificate and assign an HTTPS URL (e.g., `https://priceradar-production.up.railway.app`).

---

## Step 5: Verify Cloud Deployment

1. Open `https://<your-railway-domain>/api/health` in your browser:
   - Should return HTTP 200 OK (minimal unauthenticated readiness probe, zero internal paths or timestamps leaked):
     ```json
     {
       "status": "healthy",
       "ready": true
     }
     ```
2. Open `https://<your-railway-domain>/`:
   - Enter your `PRICERADAR_WEB_PASSWORD` when prompted by the browser (HTTP Basic Auth).
   - The Overview dashboard renders with real-time statistics from the initial collection run. Synthetic data is clearly labeled with `[DEMO SINTÉTICO]`.
3. Open `https://<your-railway-domain>/system`:
   - View the live infrastructure telemetry, scheduler state, and the audit table of recent scan runs.
4. (Optional) Inspect authenticated telemetry at `https://<your-railway-domain>/api/telemetry`:
   - Returns detailed operational and scheduler metrics protected behind mandatory authentication.

---

## Updating the Deployment

Whenever code is merged into `main` (or your configured branch), Railway automatically pulls the latest commit, builds the Docker image in the cloud, mounts the existing `/data` volume, and restarts the service with zero downtime.
