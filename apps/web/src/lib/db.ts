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
  readonly isScanning?: boolean;
  readonly totalScansExecuted: number;
  readonly lastHeartbeatAt?: string;
  readonly lastScanStartedAt?: string;
  readonly lastScanCompletedAt?: string;
  readonly lastScanStatus?: string;
  readonly nextScheduledScanAt?: string;
  readonly intervalMinutes: number;
  readonly activeProvider: string;
  readonly lastErrorSummary?: string;
  readonly isStale?: boolean;
}

let cachedRepo: SqlitePrivateHistoryRepository | null = null;
let cachedPath: string | null = null;

export interface StorageReadinessResult {
  readonly ready: boolean;
  readonly isFirstTimeInit: boolean;
  readonly storageDirExists: boolean;
  readonly storageDirWritable: boolean;
  readonly dbExists: boolean;
  readonly reason?: string;
}

export interface SystemReadinessResult {
  readonly ready: boolean;
  readonly storage: StorageReadinessResult;
  readonly schedulerReady: boolean;
  readonly reason?: string;
}

export function getDatabasePath(): string {
  return process.env.PRICERADAR_SQLITE_PATH ?? DEFAULT_PRIVATE_SQLITE_DB_PATH;
}

/**
 * Validates persistent storage readiness for cloud and local deployments (`F7-08`).
 * - In cloud/production mode, mandatory persistent volume mount (/data) must exist and be writable.
 * - Distinguishes legitimate first deployment initialization (mounted, writable, but DB not yet seeded)
 *   from failed/missing volume mounts or read-only filesystems.
 * - Verifies SQLite readability and schema integrity when database file exists.
 */
export function checkStorageReadiness(): StorageReadinessResult {
  const dbPath = path.resolve(getDatabasePath());
  const storageDir = path.dirname(dbPath);
  const storageDirExists = fs.existsSync(storageDir);
  let storageDirWritable = false;

  if (storageDirExists) {
    try {
      fs.accessSync(storageDir, fs.constants.W_OK);
      storageDirWritable = true;
    } catch {
      storageDirWritable = false;
    }
  }

  // 1. Persistent storage directory must exist
  if (!storageDirExists) {
    return {
      ready: false,
      isFirstTimeInit: false,
      storageDirExists: false,
      storageDirWritable: false,
      dbExists: false,
      reason: `Storage directory does not exist at '${storageDir}'. Persistent volume mount missing.`,
    };
  }

  // 2. Persistent storage directory must be writable
  if (!storageDirWritable) {
    return {
      ready: false,
      isFirstTimeInit: false,
      storageDirExists: true,
      storageDirWritable: false,
      dbExists: false,
      reason: `Storage directory at '${storageDir}' is not writable. Check mount permissions.`,
    };
  }

  const dbExists = fs.existsSync(dbPath);

  // 3. First-time initialization: storage volume is mounted and writable, but DB not yet created
  if (!dbExists) {
    return {
      ready: true,
      isFirstTimeInit: true,
      storageDirExists,
      storageDirWritable,
      dbExists: false,
    };
  }

  // 4. If database exists, verify SQLite readability and integrity
  try {
    const { repo } = getReadOnlyDatabase();
    if (!repo) {
      return {
        ready: false,
        isFirstTimeInit: false,
        storageDirExists,
        storageDirWritable,
        dbExists: true,
        reason: "Failed to open read-only database repository.",
      };
    }
    repo.getDashboardSummary();
    return {
      ready: true,
      isFirstTimeInit: false,
      storageDirExists,
      storageDirWritable,
      dbExists: true,
    };
  } catch (err: unknown) {
    return {
      ready: false,
      isFirstTimeInit: false,
      storageDirExists,
      storageDirWritable,
      dbExists: true,
      reason: `Database file at '${dbPath}' is unreadable or corrupt: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Checks system readiness combining storage integrity and scheduler health (`F7-08`).
 */
export function checkSystemReadiness(): SystemReadinessResult {
  const storage = checkStorageReadiness();
  if (!storage.ready) {
    return {
      ready: false,
      storage,
      schedulerReady: false,
      ...(storage.reason ? { reason: storage.reason } : {}),
    };
  }

  const isCloud =
    process.env.PRICERADAR_ENV === "cloud" ||
    Boolean(process.env.RAILWAY_ENVIRONMENT) ||
    Boolean(process.env.RENDER);

  if (isCloud) {
    const schedulerStatus = fetchSchedulerStatus(90_000);
    // If scheduler status reports stale heartbeat in cloud mode, system is not ready
    if (schedulerStatus?.isStale) {
      return {
        ready: false,
        storage,
        schedulerReady: false,
        reason: "Scheduler heartbeat is stale or inactive.",
      };
    }
  }

  return {
    ready: true,
    storage,
    schedulerReady: true,
  };
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

/**
 * Retrieves the current scheduler status (`F7-05`).
 * Validates timestamped heartbeat against freshness threshold (default 90s).
 * Recovers or augments status from durable SQLite scan_runs table when file is missing or corrupted.
 */
export function fetchSchedulerStatus(
  freshnessThresholdMs = 90_000,
): CloudSchedulerStatusInfo | null {
  const dbPath = path.resolve(getDatabasePath());
  const statusFile = path.join(path.dirname(dbPath), "scheduler-status.json");
  let status: CloudSchedulerStatusInfo | null = null;

  if (fs.existsSync(statusFile)) {
    try {
      const content = fs.readFileSync(statusFile, "utf-8");
      status = JSON.parse(content) as CloudSchedulerStatusInfo;
    } catch {
      status = null;
    }
  }

  // F7-05: Heartbeat freshness verification
  if (status) {
    if (status.isRunning && status.lastHeartbeatAt) {
      const heartbeatAgeMs = Date.now() - Date.parse(status.lastHeartbeatAt);
      if (heartbeatAgeMs > freshnessThresholdMs) {
        status = {
          ...status,
          isRunning: false,
          isScanning: false,
          isStale: true,
        };
      }
    }
  }

  // F7-05: Fallback / augment with durable SQLite scan runs
  const { repo, dbExists } = getReadOnlyDatabase();
  if (repo && dbExists) {
    try {
      const recentRuns = repo.listRecentScanRuns(1);
      const latestRun = recentRuns[0];
      if (latestRun) {
        if (!status) {
          status = {
            isRunning: false,
            isScanning: false,
            isStale: true,
            totalScansExecuted: 1,
            lastScanStartedAt: latestRun.startedAt,
            ...(latestRun.completedAt
              ? { lastScanCompletedAt: latestRun.completedAt }
              : {}),
            lastScanStatus:
              latestRun.status === "SUCCEEDED" ? "SUCCEEDED" : latestRun.status,
            intervalMinutes: 60,
            activeProvider: latestRun.providerId ?? "fixture-colombia",
            ...(latestRun.errorSummary
              ? { lastErrorSummary: latestRun.errorSummary }
              : {}),
          };
        } else if (!status.lastScanStartedAt) {
          status = {
            ...status,
            lastScanStartedAt: latestRun.startedAt,
            ...(latestRun.completedAt
              ? { lastScanCompletedAt: latestRun.completedAt }
              : {}),
            lastScanStatus:
              status.lastScanStatus ??
              (latestRun.status === "SUCCEEDED" ? "SUCCEEDED" : latestRun.status),
          };
        }
      }
    } catch {
      // Best-effort database fallback
    }
  }

  return status;
}
