import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqlitePrivateHistoryRepository } from "@priceradar/database";
import { CloudScheduler } from "../src/cloud-scheduler";

describe("Cloud Scheduler (P5 Cloud-First Milestone 1)", () => {
  let tempDir: string;
  let dbPath: string;
  let statusFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-sched-test-"));
    dbPath = path.join(tempDir, "private-history.sqlite");
    statusFilePath = path.join(tempDir, "scheduler-status.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes with standby status before start()", () => {
    const scheduler = new CloudScheduler({
      dbPath,
      statusFilePath,
      intervalMinutes: 30,
      scanOnStartup: false,
    });

    const status = scheduler.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.totalScansExecuted).toBe(0);
    expect(status.intervalMinutes).toBe(30);
    expect(status.activeProvider).toBe("fixture-colombia");
  });

  it("executes scheduled collection scan and persists observations and scan_runs to SQLite", async () => {
    const logs: string[] = [];
    const scheduler = new CloudScheduler({
      dbPath,
      statusFilePath,
      intervalMinutes: 15,
      scanOnStartup: false,
      logger: (msg) => logs.push(msg),
    });

    const result = await scheduler.executeScheduledScan();
    expect(result).not.toBeNull();
    expect(result?.persisted).toBe(true);
    expect(result?.observationsInserted).toBeGreaterThan(0);

    const status = scheduler.getStatus();
    expect(status.totalScansExecuted).toBe(1);
    expect(status.lastScanStatus).toBe("SUCCEEDED");
    expect(status.lastScanCompletedAt).toBeDefined();

    // Verify status file written to disk
    expect(fs.existsSync(statusFilePath)).toBe(true);
    const fileContent = JSON.parse(fs.readFileSync(statusFilePath, "utf-8"));
    expect(fileContent.totalScansExecuted).toBe(1);
    expect(fileContent.lastScanStatus).toBe("SUCCEEDED");

    // Verify SQLite contains the scan run
    const repo = new SqlitePrivateHistoryRepository(dbPath, { readOnly: true });
    const runs = repo.listRecentScanRuns(5);
    repo.close();

    expect(runs.length).toBe(1);
    expect(runs[0]?.scanRunId).toContain("cloud-sched-");
    expect(runs[0]?.status).toBe("SUCCEEDED");
    expect(runs[0]?.validObservations).toBeGreaterThan(0);
  });

  it("starts and stops cleanly without leaving dangling timers", async () => {
    const scheduler = new CloudScheduler({
      dbPath,
      statusFilePath,
      intervalMinutes: 60,
      scanOnStartup: true, // will execute 1 scan on start
    });

    await scheduler.start();
    expect(scheduler.getStatus().isRunning).toBe(true);
    expect(scheduler.getStatus().totalScansExecuted).toBe(1);

    scheduler.stop();
    expect(scheduler.getStatus().isRunning).toBe(false);
    expect(scheduler.getStatus().nextScheduledScanAt).toBeUndefined();

    const fileContent = JSON.parse(fs.readFileSync(statusFilePath, "utf-8"));
    expect(fileContent.isRunning).toBe(false);
  });
});
