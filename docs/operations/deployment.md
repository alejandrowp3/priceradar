# Deployment Architecture & Cloud Topology (Phase P5)

## 1. Operational Invariant: Cloud-First Deployment

PriceRadar is hosted in the cloud from the first deployable increment (Phase P5).  
Local Docker installations, local background workers, and keeping the owner's personal computer powered on are explicitly deprecated for routine operations.

- **Primary Cloud Platform**: [Railway](https://railway.com) (Managed container platform).
- **Alternative Cloud Platform**: [Render](https://render.com) (Blueprint specification in `render.yaml`).
- **Detailed Architecture Specification**: [`docs/architecture/p5-cloud-first-architecture.md`](../architecture/p5-cloud-first-architecture.md)
- **Deployment Procedure**: [`docs/operations/cloud-deployment-guide.md`](./cloud-deployment-guide.md)

---

## 2. Cloud Architecture Topology (Phase P5 Milestone 1)

| Component                         | Platform / Technology                                          | Configuration Notes                                                                                                    |
| :-------------------------------- | :------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **Container Platform**            | Railway                                                        | Multi-stage Docker build from GitHub (`Dockerfile`). Zero local Docker commands.                                       |
| **Private Web Dashboard**         | Next.js 15 (App Router)                                        | Hosted on managed HTTPS domain. Secured via HTTP Basic Auth (`PRICERADAR_WEB_PASSWORD`) and DNS rebinding protections. |
| **Background Scheduler & Worker** | In-Process Cloud Worker (`apps/worker/src/cloud-scheduler.ts`) | Periodic automated collection every 60 min. Runs deterministic test collector (`fixture-colombia`) in Milestone 1.     |
| **Persistent Storage**            | Persistent SSD Volume (`/data`)                                | Durable SQLite 3 database in WAL mode (`/data/private-history.sqlite`), isolated outside Git repository.               |
| **Platform Health Check**         | `/api/health`                                                  | Automated container orchestrator probe returning structured health status.                                             |
| **Estimated Monthly Cost**        | ~$8.00 – $12.00 / month                                        | Usage-based compute + 5 GB SSD persistent volume.                                                                      |

---

## 3. Remote Session & Security Governance

- **Zero CAPTCHA / Access Control Bypass**: The worker never attempts to solve CAPTCHAs, bypass Cloudflare gates, or force authentication.
- **Owner-Supervised Session Transfer**: Live Rappi Turbo delivery sessions are authorized by the owner locally and transferred via authenticated, encrypted sync (`pnpm cloud:session-sync`) or remote interactive stream.
- **Privacy Assurance**: No raw personal delivery addresses, street names, or unredacted credentials are ever committed or exposed publicly.
