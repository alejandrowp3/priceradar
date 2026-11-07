# Contributing to PriceRadar

## 1. Engineering Conventions

- **Code & Documentation Language:** All source code, identifiers, database schemas, tests, comments, commit messages, and technical documentation must be written in **English**.
- **User Interface Language:** All user-facing UI text, labels, dates, and currency formatting must use **Colombian Spanish (`es-CO`)** and integer Colombian Pesos (`COP`).
- **Commit Format:** Follow Conventional Commits:
  - `feat(discovery): implement fixture catalog provider`
  - `fix(pricing): exclude current observation from historical baseline`
  - `test(worker): verify scan idempotency`
  - `docs(architecture): document provider adapter strategy`

## 2. Local Verification Gate

Before committing changes, run:

```bash
pnpm check:port
pnpm lint
pnpm typecheck
pnpm test
pnpm worker:scan
```

## 3. Repository & Credential Isolation

- Confirm `git remote -v` points to `git@github-personal:alejandrowp3/priceradar.git`.
- Confirm `git config --local user.email` is `alejandrowp3@gmail.com`.
- Never commit `.env` files, tokens, or unredacted network captures.

## 4. Branching & Pull Request Workflow (Post-Initial Publication)

After the initial baseline is published to `main`:

1. **Protected Integration Baseline:** Treat `main` as the protected integration baseline. Do not push directly to `main` unless explicitly authorized by the repository owner.
2. **Feature Branches:** Create dedicated feature branches (`feat/...`, `fix/...`, `chore/...`) for all subsequent work.
3. **Pull Requests:** Open pull requests for changes to the price-history engine (`@priceradar/domain`), Rappi provider (`@priceradar/providers`), worker (`@priceradar/worker`), and private/public web interfaces (`@priceradar/web`).
4. **CI & Adversarial Verification:** Require all CI gates (`pnpm check:port`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`) and independent adversarial review for significant architectural or security changes before merging.
