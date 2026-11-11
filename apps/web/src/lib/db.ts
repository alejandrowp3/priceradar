import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PRIVATE_SQLITE_DB_PATH,
  SqlitePrivateHistoryRepository,
} from "@priceradar/database";
import type {
  CatalogCoverageReport,
  CatalogProductSummaryItem,
  DashboardOpportunityItem,
  DashboardSummary,
  ListActiveOpportunitiesOptions,
  ListCatalogProductsOptions,
  PaginatedResult,
  ProductDetailView,
  PersistedScanRunRow,
} from "@priceradar/database";

export interface CloudSchedulerStatusInfo {
  readonly isRunning: boolean;
  readonly totalScansExecuted: number;
  readonly lastScanStartedAt?: string;
  readonly lastScanCompletedAt?: string;
  readonly lastScanStatus?: string;
  readonly nextScheduledScanAt?: string;
  readonly intervalMinutes: number;
  readonly activeProvider: string;
  readonly lastErrorSummary?: string;
}

let cachedRepo: SqlitePrivateHistoryRepository | null = null;
let cachedPath: string | null = null;

export function getDatabasePath(): string {
  return process.env.PRICERADAR_SQLITE_PATH ?? DEFAULT_PRIVATE_SQLITE_DB_PATH;
}

/**
 * Returns a strictly read-only repository connection, or null if database file does not exist yet.
 */
export function getReadOnlyDatabase(): {
  readonly repo: SqlitePrivateHistoryRepository | null;
  readonly dbExists: boolean;
  readonly dbPath: string;
} {
  const dbPath = path.resolve(getDatabasePath());
  const dbExists = fs.existsSync(dbPath);

  if (!dbExists) {
    return { repo: null, dbExists: false, dbPath };
  }

  if (cachedRepo && cachedPath === dbPath) {
    return { repo: cachedRepo, dbExists: true, dbPath };
  }

  if (cachedRepo) {
    try {
      cachedRepo.close();
    } catch {
      // Ignore close error on cached instance
    }
  }

  cachedRepo = new SqlitePrivateHistoryRepository(dbPath, { readOnly: true });
  cachedPath = dbPath;

  return { repo: cachedRepo, dbExists: true, dbPath };
}

export function fetchDashboardSummary(): {
  readonly summary: DashboardSummary | null;
  readonly dbExists: boolean;
} {
  const { repo, dbExists } = getReadOnlyDatabase();
  if (!repo || !dbExists) {
    return { summary: null, dbExists: false };
  }
  return { summary: repo.getDashboardSummary(), dbExists: true };
}

export function fetchCatalogProducts(options?: ListCatalogProductsOptions): {
  readonly result: PaginatedResult<CatalogProductSummaryItem> | null;
  readonly dbExists: boolean;
} {
  const { repo, dbExists } = getReadOnlyDatabase();
  if (!repo || !dbExists) {
    return { result: null, dbExists: false };
  }
  return { result: repo.listCatalogProducts(options), dbExists: true };
}

export function fetchProductDetail(productIdOrKey: string): {
  readonly detail: ProductDetailView | null;
  readonly dbExists: boolean;
} {
  const { repo, dbExists } = getReadOnlyDatabase();
  if (!repo || !dbExists) {
    return { detail: null, dbExists: false };
  }
  return { detail: repo.getProductDetail(productIdOrKey) ?? null, dbExists: true };
}

export function fetchActiveOpportunities(options?: ListActiveOpportunitiesOptions): {
  readonly result: PaginatedResult<DashboardOpportunityItem> | null;
  readonly dbExists: boolean;
} {
  const { repo, dbExists } = getReadOnlyDatabase();
  if (!repo || !dbExists) {
    return { result: null, dbExists: false };
  }
  return { result: repo.listActiveOpportunities(options), dbExists: true };
}

export function fetchCoverageReport(): {
  readonly report: CatalogCoverageReport | null;
  readonly dbExists: boolean;
} {
  const { repo, dbExists } = getReadOnlyDatabase();
  if (!repo || !dbExists) {
    return { report: null, dbExists: false };
  }
  return { report: repo.getCatalogCoverageReport(), dbExists: true };
}

export function fetchRecentScanRuns(limit = 20): {
  readonly runs: readonly PersistedScanRunRow[];
  readonly dbExists: boolean;
} {
  const { repo, dbExists } = getReadOnlyDatabase();
  if (!repo || !dbExists) {
    return { runs: [], dbExists: false };
  }
  return { runs: repo.listRecentScanRuns(limit), dbExists: true };
}

export function fetchSchedulerStatus(): CloudSchedulerStatusInfo | null {
  const dbPath = path.resolve(getDatabasePath());
  const statusFile = path.join(path.dirname(dbPath), "scheduler-status.json");
  if (fs.existsSync(statusFile)) {
    try {
      const content = fs.readFileSync(statusFile, "utf-8");
      return JSON.parse(content) as CloudSchedulerStatusInfo;
    } catch {
      return null;
    }
  }
  return null;
}
