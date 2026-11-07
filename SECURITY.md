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
8. **Phase P2 Private SQLite Storage Controls:**
   - **Location Outside Repository:** The private price history SQLite database defaults to `~/.local/share/priceradar/private-history.sqlite`. `assertDatabasePathOutsideRepository` blocks any database path inside the Git repository tree, and `.gitignore` blocks `*.sqlite*`, `*.db*`, and `*.bak` files.
   - **Filesystem Permissions:** The parent directory `~/.local/share/priceradar` is enforced as `0700` (owner-only rwx), and `private-history.sqlite` (plus `-wal` and `-shm` sidecar files) is enforced as `0600` (owner-only rw).
   - **Redacted Storage Only (`assertNoSensitiveTextInPersistedString`):** Street addresses, apartment/interior numbers, emails, phone numbers, session cookies, bearer tokens, and raw HMAC keys are rejected before any SQLite write. Only the keyed HMAC identifier (`ctx-<16hex>`) and coarse city metadata are stored.
   - **Honest Provenance Constraints:** SQL `CHECK` constraints enforce that provisional session observations (`PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL`) always carry `address_specific_pricing_verified = 0` and `geographic_verification_verdict = 'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION'`.
   - **Explicit Owner Consent:** Observations are never written automatically during browser inspection; `--save` requires interactive owner confirmation (`SI`) after displaying a redacted pre-save summary.
   - **Remaining Local Risks:** Local SQLite files rely on OS user account isolation and full-disk encryption (macOS FileVault). Ensure FileVault is enabled on the personal machine and never copy `~/.local/share/priceradar/*.sqlite` into cloud-synced folders or public repositories.
