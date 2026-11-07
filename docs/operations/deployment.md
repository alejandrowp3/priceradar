# Deployment Architecture & Gate Policy

## 1. Current Status (Phase 0)

**No external services are provisioned and no deployment is active.**  
Provisioning Neon PostgreSQL or deploying to Vercel requires explicit repository owner authorization in Phases 2 and 5.

---

## 2. Planned Target Topology (USD $0/Month)

| Component                           | Platform                        | Plan                                    | Configuration Notes                                                                                                                                           |
| ----------------------------------- | ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Frontend & Public Read-Only API | Vercel                          | Hobby (Personal, Non-Commercial)        | Separate Vercel project (`priceradar`); `Root Directory` set to `apps/web`. Never modify existing Vercel deployments.                                         |
| Relational Database                 | Neon PostgreSQL                 | Free Tier (1 GB storage, 100 CU-hrs/mo) | Use pooled connection string (`DATABASE_URL`) for Next.js Server Components; unpooled (`DATABASE_URL_UNPOOLED`) for migrations. Pin max compute to `0.25 CU`. |
| Admin Authentication                | Neon Auth (Managed Better Auth) | Free Tier (60,000 MAUs)                 | Server-side session verification + explicit `admin_users` allowlist on `/admin/*` routes and Server Actions.                                                  |
| Scheduled Discovery Worker          | GitHub Actions                  | Free Public Repo Runners                | `.github/workflows/discovery-scan.yml` (`cron: "7,22,37,52 * * * *"`), disabled until Phase 3 authorization.                                                  |
