import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PRIVATE_SQLITE_DB_PATH,
  SqlitePrivateHistoryRepository,
  verifyStoragePersistenceContract,
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
  PersistenceTier,
  VolumeMarkerInfo,
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
  readonly isFutureDated?: boolean;
  readonly isInvalid?: boolean;
  readonly heartbeatAgeMs?: number;
}

let cachedRepo: SqlitePrivateHistoryRepository | null = null;
let cachedPath: string | null = null;

export interface StorageReadinessResult {
  readonly ready: boolean;
  readonly isFirstTimeInit: boolean;
  readonly storageDirExists: boolean;
  readonly storageDirWritable: boolean;
  readonly dbExists: boolean;
  readonly persistenceTier: PersistenceTier;
  readonly persistenceVerified: boolean;
  readonly volumeMarker?: VolumeMarkerInfo | null;
  readonly reason?: string;
}

export interface SystemReadinessResult {
  readonly ready: boolean;
  readonly storage: StorageReadinessResult;
  readonly schedulerReady: boolean;
  readonly isInitialStartup?: boolean;
  readonly reason?: string;
}

export interface SystemReadinessOptions {
  readonly nowMs?: number;
  readonly uptimeMs?: number;
  readonly startupGracePeriodMs?: number;
  readonly freshnessThresholdMs?: number;
  readonly maxFutureToleranceMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export function getDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PRICERADAR_SQLITE_PATH ?? DEFAULT_PRIVATE_SQLITE_DB_PATH;
}

/**
 * Validates persistent storage readiness for cloud and local deployments (`F7-08`, `F7-11`).
 * - Distinguishes a verified persistent volume from an ephemeral container filesystem (`F7-11`).
 * - In Railway mode, requires attached Railway volume (RAILWAY_VOLUME_NAME / PRICERADAR_VOLUME_NAME).
 * - Distinguishes legitimate first deployment initialization (mounted, writable, but DB not yet seeded)
 *   from failed/missing volume mounts or read-only filesystems.
 * - Verifies SQLite readability and schema integrity when database file exists.
 */
export function checkStorageReadiness(options?: {
  readonly env?: NodeJS.ProcessEnv;
}): StorageReadinessResult {
  const env = options?.env ?? process.env;
  const dbPath = path.resolve(getDatabasePath(env));
  const storageDir = path.dirname(dbPath);

  // F7-11: Explicitly verify storage persistence contract
  const persistenceContract = verifyStoragePersistenceContract(storageDir, env);

  if (!persistenceContract.persistenceVerified) {
    return {
      ready: false,
      isFirstTimeInit: false,
      storageDirExists: persistenceContract.storageDirExists,
      storageDirWritable: persistenceContract.storageDirWritable,
      dbExists: fs.existsSync(dbPath),
      persistenceTier: persistenceContract.persistenceTier,
      persistenceVerified: false,
      volumeMarker: persistenceContract.volumeMarker,
      ...(persistenceContract.reason ? { reason: persistenceContract.reason } : {}),
    };
  }

  const dbExists = fs.existsSync(dbPath);

  // First-time initialization: persistent volume is verified and writable, DB not yet created
  if (!dbExists) {
    return {
      ready: true,
      isFirstTimeInit: true,
      storageDirExists: true,
      storageDirWritable: true,
      dbExists: false,
      persistenceTier: persistenceContract.persistenceTier,
      persistenceVerified: true,
      volumeMarker: persistenceContract.volumeMarker,
    };
  }

  // Database exists: verify SQLite readability and schema integrity
  try {
    const { repo } = getReadOnlyDatabase(dbPath);
    if (!repo) {
      return {
        ready: false,
        isFirstTimeInit: false,
        storageDirExists: true,
        storageDirWritable: true,
        dbExists: true,
        persistenceTier: persistenceContract.persistenceTier,
        persistenceVerified: true,
        volumeMarker: persistenceContract.volumeMarker,
        reason: "Failed to open read-only database repository.",
      };
    }
    repo.getDashboardSummary();
    return {
      ready: true,
      isFirstTimeInit: false,
      storageDirExists: true,
      storageDirWritable: true,
      dbExists: true,
      persistenceTier: persistenceContract.persistenceTier,
      persistenceVerified: true,
      volumeMarker: persistenceContract.volumeMarker,
    };
  } catch (err: unknown) {
    return {
      ready: false,
      isFirstTimeInit: false,
      storageDirExists: true,
      storageDirWritable: true,
      dbExists: true,
      persistenceTier: persistenceContract.persistenceTier,
      persistenceVerified: true,
      volumeMarker: persistenceContract.volumeMarker,
      reason: `Database file at '${dbPath}' is unreadable or corrupt: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Checks system readiness combining storage integrity and scheduler health (`F7-08`, `F7-10`, `F7-11`).
 * - Requires positive evidence of an active scheduler in cloud mode (`F7-10`).
 * - Rejects missing, stopped, stale, invalid, or future-dated scheduler heartbeats.
 * - Recognizes genuine initial startup without masking permanent failures or deadlocking readiness.
 */
export function checkSystemReadiness(
  options?: SystemReadinessOptions,
): SystemReadinessResult {
  const env = options?.env ?? process.env;
  const storage = checkStorageReadiness({ env });
  if (!storage.ready) {
    return {
      ready: false,
      storage,
      schedulerReady: false,
      ...(storage.reason ? { reason: storage.reason } : {}),
    };
  }

  const isCloud =
    env.PRICERADAR_ENV === "cloud" ||
    Boolean(env.RAILWAY_ENVIRONMENT) ||
    Boolean(env.RENDER) ||
    Boolean(env.FLY_APP_NAME);

  if (isCloud) {
    const schedulerStatus = fetchSchedulerStatus({
      ...(options?.freshnessThresholdMs !== undefined
        ? { freshnessThresholdMs: options.freshnessThresholdMs }
        : {}),
      ...(options?.maxFutureToleranceMs !== undefined
        ? { maxFutureToleranceMs: options.maxFutureToleranceMs }
        : {}),
      ...(options?.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(env !== undefined ? { env } : {}),
    });

    // 1. Missing scheduler status (no status file or corrupted format)
    if (!schedulerStatus) {
      const uptimeMs =
        options?.uptimeMs !== undefined ? options.uptimeMs : process.uptime() * 1000;
      const gracePeriodMs = options?.startupGracePeriodMs ?? 10_000;
      const isWithinGrace = uptimeMs < gracePeriodMs;

      return {
        ready: false,
        storage,
        schedulerReady: false,
        reason: isWithinGrace
          ? "Scheduler is initializing during startup grace window."
          : "Missing scheduler status: no active scheduler process found.",
      };
    }

    // 2. Stale, future-dated, or invalid heartbeat
    if (
      schedulerStatus.isStale ||
      schedulerStatus.isInvalid ||
      schedulerStatus.isFutureDated
    ) {
      let staleReason = "Scheduler heartbeat is stale or inactive.";
      if (schedulerStatus.isFutureDated) {
        staleReason =
          "Scheduler heartbeat timestamp is future-dated (clock skew or invalid state).";
      } else if (schedulerStatus.isInvalid) {
        staleReason = "Scheduler heartbeat timestamp is malformed or invalid.";
      }
      return {
        ready: false,
        storage,
        schedulerReady: false,
        reason: staleReason,
      };
    }

    // 3. Explicitly stopped scheduler
    if (!schedulerStatus.isRunning) {
      return {
        ready: false,
        storage,
        schedulerReady: false,
        reason: "Scheduler is explicitly stopped or inactive.",
      };
    }

    // 4. Positive evidence verified: scheduler actively running with fresh heartbeat!
    const isInitialStartup =
      storage.isFirstTimeInit && schedulerStatus.totalScansExecuted === 0;

    return {
      ready: true,
      storage,
      schedulerReady: true,
      ...(isInitialStartup ? { isInitialStartup: true } : {}),
    };
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
export function getReadOnlyDatabase(overridePath?: string): {
  readonly repo: SqlitePrivateHistoryRepository | null;
  readonly dbExists: boolean;
  readonly dbPath: string;
} {
  const dbPath = path.resolve(overridePath ?? getDatabasePath());
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
 * Retrieves the current scheduler status (`F7-05`, `F7-10`).
 * Validates timestamped heartbeat against freshness threshold (default 90s) and future clock skew tolerance (default 5s).
 * Recovers or augments status from durable SQLite scan_runs table when file is missing or corrupted.
 */
export interface FetchSchedulerStatusOptions {
  readonly freshnessThresholdMs?: number;
  readonly maxFutureToleranceMs?: number;
  readonly nowMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly statusFilePath?: string;
}

export function fetchSchedulerStatus(
  optionsOrThreshold?: number | FetchSchedulerStatusOptions,
): CloudSchedulerStatusInfo | null {
  const options =
    typeof optionsOrThreshold === "number"
      ? { freshnessThresholdMs: optionsOrThreshold }
      : (optionsOrThreshold ?? {});

  const now = options.nowMs ?? Date.now();
  const freshnessThresholdMs = options.freshnessThresholdMs ?? 90_000;
  const maxFutureToleranceMs = options.maxFutureToleranceMs ?? 5_000;

  const dbPath = path.resolve(getDatabasePath(options.env));
  const statusFile =
    options.statusFilePath ?? path.join(path.dirname(dbPath), "scheduler-status.json");
  let status: CloudSchedulerStatusInfo | null = null;

  if (fs.existsSync(statusFile)) {
    try {
      const content = fs.readFileSync(statusFile, "utf-8");
      status = JSON.parse(content) as CloudSchedulerStatusInfo;
    } catch {
      status = null;
    }
  }

  // F7-05 & F7-10: Heartbeat freshness and validity verification
  if (status) {
    if (!status.lastHeartbeatAt) {
      status = {
        ...status,
        isRunning: false,
        isScanning: false,
        isInvalid: true,
        isStale: true,
      };
    } else {
      const heartbeatTime = Date.parse(status.lastHeartbeatAt);
      if (isNaN(heartbeatTime)) {
        status = {
          ...status,
          isRunning: false,
          isScanning: false,
          isInvalid: true,
          isStale: true,
        };
      } else {
        const heartbeatAgeMs = now - heartbeatTime;
        if (heartbeatAgeMs < -maxFutureToleranceMs) {
          // Future-dated heartbeat (clock skew or forged state)
          status = {
            ...status,
            isRunning: false,
            isScanning: false,
            isFutureDated: true,
            isStale: true,
            heartbeatAgeMs,
          };
        } else if (heartbeatAgeMs > freshnessThresholdMs) {
          // Stale heartbeat
          status = {
            ...status,
            isRunning: false,
            isScanning: false,
            isStale: true,
            heartbeatAgeMs,
          };
        } else {
          status = {
            ...status,
            heartbeatAgeMs,
          };
        }
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
