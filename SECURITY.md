# Security Policy

## 1. Public Repository Threat Model

`alejandrowp3/priceradar` is a **public repository**. Assume all committed files, commit messages, and Git history are permanently visible to the public.

## 2. Mandatory Security Controls

1. **Zero Committed Secrets:** Never commit `.env`, `.env.local`, database connection strings, OAuth secrets, SSH keys, session cookies, or personal geographic coordinates.
2. **Read-Only Public Boundary:** Public dashboard routes (`/`, `/explorar`, `/ofertas/[id]`, `/estadisticas`, `/como-funciona`) are strictly read-only and never expose mutation endpoints or privileged credentials.
3. **Server-Enforced Admin Authorization:** Administrative routes (`/admin/*`) and scan triggers must verify authentication and explicit owner authorization on the server. Hiding UI links is never treated as authorization.
4. **Least-Privilege GitHub Actions:**
   - Default workflow `permissions` are restricted to `contents: read`.
   - Third-party GitHub Actions are pinned to immutable full-length commit SHAs.
   - Production write secrets are never exposed to `pull_request` workflows from forks.
5. **Corporate Identity Isolation:** Never use corporate GitHub credentials, tokens, or SSH keys for PriceRadar operations.
6. **Provider Compliance:** PriceRadar strictly prohibits WAF/CAPTCHA evasion, unauthorized credential stuffing, stealth scraping plugins, or residential proxy rotation.
7. **Browser Session & Personal Address Isolation:** Never request, log, or store retailer account passwords, session cookies, `storageState.json` files, HAR captures, or personal delivery street addresses in the repository or in GitHub Actions Secrets. Any owner-supervised browser profile must reside outside the repository with `0700` permissions, and any real observations (`LIVE_PRIVATE`) must never be exposed on public unauthenticated routes.
