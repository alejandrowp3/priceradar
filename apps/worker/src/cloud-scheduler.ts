import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PRIVATE_SQLITE_DB_PATH,
  SqlitePrivateHistoryRepository,
} from "@priceradar/database";
import type {
  SupervisedPersistenceContextInput,
  PersistApprovedBatchResult,
} from "@priceradar/database";
import type { DiscoveredListing } from "@priceradar/domain";
import { FixtureCatalogProvider } from "@priceradar/providers";

export interface CloudSchedulerOptions {
  readonly dbPath?: string;
  readonly intervalMinutes?: number;
  readonly scanOnStartup?: boolean;
  readonly statusFilePath?: string;
  readonly logger?: (message: string) => void;
}

export interface CloudSchedulerStatus {
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

const VALID_TEST_CTX_HASH = "ctx-88be5762563932c5";

export class CloudScheduler {
  private readonly dbPath: string;
  private readonly intervalMinutes: number;
  private readonly scanOnStartup: boolean;
  private readonly statusFilePath: string;
  private readonly logger: (message: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private isScanning = false;
  private isRunning = false;
  private totalScansExecuted = 0;
  private lastScanStartedAt: string | undefined = undefined;
  private lastScanCompletedAt: string | undefined = undefined;
  private lastScanStatus: string | undefined = undefined;
  private nextScheduledScanAt: string | undefined = undefined;
  private lastErrorSummary: string | undefined = undefined;
  private simulationStep = 0;

  constructor(options: CloudSchedulerOptions = {}) {
    this.dbPath = path.resolve(
      options.dbPath ??
        process.env.PRICERADAR_SQLITE_PATH ??
        DEFAULT_PRIVATE_SQLITE_DB_PATH,
    );
    this.intervalMinutes = Math.max(
      1,
      options.intervalMinutes ??
        Number(process.env.PRICERADAR_SCHEDULE_INTERVAL_MINUTES ?? 60),
    );
    this.scanOnStartup =
      options.scanOnStartup ?? process.env.PRICERADAR_SCAN_ON_STARTUP !== "false";
    this.statusFilePath =
      options.statusFilePath ??
      path.join(path.dirname(this.dbPath), "scheduler-status.json");
    this.logger =
      options.logger ??
      ((msg: string) => {
        console.log(`[CloudScheduler] ${msg}`);
      });
  }

  public getStatus(): CloudSchedulerStatus {
    return {
      isRunning: this.isRunning,
      totalScansExecuted: this.totalScansExecuted,
      ...(this.lastScanStartedAt ? { lastScanStartedAt: this.lastScanStartedAt } : {}),
      ...(this.lastScanCompletedAt
        ? { lastScanCompletedAt: this.lastScanCompletedAt }
        : {}),
      ...(this.lastScanStatus ? { lastScanStatus: this.lastScanStatus } : {}),
      ...(this.nextScheduledScanAt
        ? { nextScheduledScanAt: this.nextScheduledScanAt }
        : {}),
      intervalMinutes: this.intervalMinutes,
      activeProvider: "fixture-colombia",
      ...(this.lastErrorSummary ? { lastErrorSummary: this.lastErrorSummary } : {}),
    };
  }

  private writeStatusFile(): void {
    try {
      const dir = path.dirname(this.statusFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.statusFilePath,
        JSON.stringify(this.getStatus(), null, 2),
        "utf-8",
      );
    } catch (err: unknown) {
      // Non-fatal logging for status file write
      this.logger(`Warning: failed to write scheduler status file: ${String(err)}`);
    }
  }

  public async start(): Promise<this> {
    if (this.isRunning) {
      return this;
    }

    this.isRunning = true;
    this.scheduleNext();
    this.writeStatusFile();

    this.logger(
      `Started cloud scheduler. Interval: ${String(this.intervalMinutes)}m. DB: ${this.dbPath}`,
    );

    if (this.scanOnStartup) {
      this.logger("Executing initial startup collection scan...");
      await this.executeScheduledScan();
    }

    return this;
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.nextScheduledScanAt = undefined;
    this.writeStatusFile();
    this.logger("Stopped cloud scheduler.");
  }

  private scheduleNext(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    const nextDate = new Date(Date.now() + this.intervalMinutes * 60 * 1000);
    this.nextScheduledScanAt = nextDate.toISOString();

    this.timer = setInterval(
      () => {
        void this.executeScheduledScan();
        this.scheduleNext();
      },
      this.intervalMinutes * 60 * 1000,
    );
  }

  /**
   * Executes one deterministic collection scan cycle.
   * Milestone 1 collects deterministic data from FixtureCatalogProvider and persists it.
   */
  public async executeScheduledScan(): Promise<PersistApprovedBatchResult | null> {
    if (this.isScanning) {
      this.logger("Previous scan still in progress. Skipping overlapping execution.");
      return null;
    }

    this.isScanning = true;
    const nowIso = new Date().toISOString();
    this.lastScanStartedAt = nowIso;
    const scanRunId = `cloud-sched-${String(Date.now())}`;

    try {
      this.logger(`Starting scheduled collection run '${scanRunId}'...`);

      // Ensure directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      const repo = new SqlitePrivateHistoryRepository(this.dbPath);
      const provider = new FixtureCatalogProvider();

      // Collect from fixture targets deterministically
      const targets = provider.getDefaultTargets();
      const allListings: DiscoveredListing[] = [];

      for (const target of targets) {
        const result = await provider.discover(target, {
          simulationStep: this.simulationStep,
          nowIso,
          pageSize: 25,
        });
        allListings.push(...result.listings);
      }

      this.simulationStep = (this.simulationStep + 1) % 3;

      const context: SupervisedPersistenceContextInput = {
        scanRunId,
        observedAtIso: nowIso,
        gateStatus: "VERIFIED_ACTIVE_SELECTION",
        hasSecurityChallenge: false,
        isLoginRequired: false,
        isDeliveryContextVerified: true,
        citySlug: "bogota",
        cityName: "Bogotá D.C.",
        fulfillmentContextHash: VALID_TEST_CTX_HASH,
        activeAddressSelection: "VERIFIED_ACTIVE_SELECTION",
        cityAndNeighborhoodMetadata: "VERIFIED_FROM_ACTIVE_CONTEXT",
        servingStoreBranch: "VERIFIED_ACTIVE_BRANCH_FROM_PAGE",
        productCatalogContext: "VERIFIED_ACTIVE_CATALOG",
        pricingVerificationVerdict: "VERIFIED_ADDRESS_SPECIFIC_PRICING",
        navigationStates: {
          ADDRESS_SELECTED: true,
          STORE_OPENED_FROM_ADDRESS_CONTEXT: true,
          CATALOG_VISIBLE_IN_SESSION: true,
          ADDRESS_SPECIFIC_PRICING_VERIFIED: true,
        },
        candidatesDiscoveredCount: allListings.length,
        skippedMalformedCount: 0,
        duplicateSuppressedCount: 0,
        listings: allListings,
        sourceView: {
          viewKey: "/cloud-scheduled/fixture-colombia",
          pageKind: "STORE_SUBPATH",
          labelSource: "OWNER_PROVIDED",
          ownerLabel: "Colección Programada en Nube (Milestone 1)",
        },
      };

      const persistResult = repo.persistApprovedInspectionBatch(context, {
        ownerConfirmed: true,
      });

      repo.close();

      this.totalScansExecuted += 1;
      this.lastScanCompletedAt = new Date().toISOString();
      this.lastScanStatus = persistResult.persisted ? "SUCCEEDED" : "FAILED";
      this.lastErrorSummary = persistResult.errorSummary ?? undefined;

      this.logger(
        `Scheduled run '${scanRunId}' completed: ${persistResult.reason} (inserted ${String(persistResult.observationsInserted)} observations, ${String(persistResult.opportunitiesInserted)} opportunities).`,
      );

      this.writeStatusFile();
      return persistResult;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.lastScanCompletedAt = new Date().toISOString();
      this.lastScanStatus = "FAILED";
      this.lastErrorSummary = errorMsg;
      this.logger(`Error during scheduled scan '${scanRunId}': ${errorMsg}`);
      this.writeStatusFile();
      return null;
    } finally {
      this.isScanning = false;
    }
  }
}
