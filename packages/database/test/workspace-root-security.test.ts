import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertDatabasePathOutsideRepository,
  getCanonicalPath,
  resolveWorkspaceRoot,
  SqlitePrivateHistoryRepository,
} from "../src/sqlite-repository.ts";

describe("Workspace Root Resolution & Database Path Security (P4 Runtime Fix)", () => {
  let tempDir: string;
  let originalCwd: string;
  let originalEnvWorkspaceRoot: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-ws-sec-"));
    originalCwd = process.cwd();
    originalEnvWorkspaceRoot = process.env.PRICERADAR_WORKSPACE_ROOT;
    delete process.env.PRICERADAR_WORKSPACE_ROOT;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalEnvWorkspaceRoot !== undefined) {
      process.env.PRICERADAR_WORKSPACE_ROOT = originalEnvWorkspaceRoot;
    } else {
      delete process.env.PRICERADAR_WORKSPACE_ROOT;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("resolveWorkspaceRoot()", () => {
    it("resolves the authentic workspace root containing pnpm-workspace.yaml and package.json (priceradar)", () => {
      const root = resolveWorkspaceRoot();
      expect(fs.existsSync(path.join(root, "pnpm-workspace.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);

      const pkg = JSON.parse(
        fs.readFileSync(path.join(root, "package.json"), "utf-8"),
      ) as { name?: string };
      expect(pkg.name).toBe("priceradar");
    });

    it("resolves the workspace root correctly when current working directory changes to a subpackage", () => {
      const realRoot = resolveWorkspaceRoot();
      const webDir = path.join(realRoot, "apps", "web");

      process.chdir(webDir);
      expect(process.cwd()).toBe(webDir);

      const resolved = resolveWorkspaceRoot();
      expect(resolved).toBe(realRoot);
    });

    it("resolves the workspace root correctly when current working directory changes to an external temporary directory", () => {
      const realRoot = resolveWorkspaceRoot();

      process.chdir(tempDir);
      expect(process.cwd()).toBe(fs.realpathSync(tempDir));

      const resolved = resolveWorkspaceRoot();
      expect(resolved).toBe(realRoot);
    });

    it("accepts a valid PRICERADAR_WORKSPACE_ROOT environment variable override", () => {
      const realRoot = resolveWorkspaceRoot();
      process.env.PRICERADAR_WORKSPACE_ROOT = realRoot;

      const resolved = resolveWorkspaceRoot();
      expect(resolved).toBe(realRoot);
    });

    it("rejects an invalid PRICERADAR_WORKSPACE_ROOT environment variable override", () => {
      process.env.PRICERADAR_WORKSPACE_ROOT = tempDir;

      expect(() => {
        resolveWorkspaceRoot();
      }).toThrow(/Security violation: PRICERADAR_WORKSPACE_ROOT is set to/);
    });
  });

  describe("assertDatabasePathOutsideRepository() & canonical containment", () => {
    it("allows :memory: database without throwing", () => {
      expect(() => {
        assertDatabasePathOutsideRepository(":memory:");
      }).not.toThrow();
    });

    it("allows a legitimate private SQLite database outside the workspace", () => {
      const safePath = path.join(tempDir, "private-history.sqlite");
      expect(() => {
        assertDatabasePathOutsideRepository(safePath);
      }).not.toThrow();
    });

    it("rejects a database file directly inside the workspace root", () => {
      const root = resolveWorkspaceRoot();
      const forbiddenPath = path.join(root, "forbidden-private-history.sqlite");

      expect(() => {
        assertDatabasePathOutsideRepository(forbiddenPath);
      }).toThrow(/must reside outside the Git repository/);
    });

    it("rejects a database file inside a workspace subdirectory", () => {
      const root = resolveWorkspaceRoot();
      const forbiddenSubPath = path.join(root, "packages", "database", "nested.sqlite");

      expect(() => {
        assertDatabasePathOutsideRepository(forbiddenSubPath);
      }).toThrow(/must reside outside the Git repository/);
    });

    it("rejects traversal paths attempting to resolve inside the workspace", () => {
      const root = resolveWorkspaceRoot();
      const traversalPath = path.join(
        root,
        "packages",
        "database",
        "..",
        "..",
        "infiltrate.sqlite",
      );

      expect(() => {
        assertDatabasePathOutsideRepository(traversalPath);
      }).toThrow(/must reside outside the Git repository/);
    });

    it("rejects symlink aliases pointing into the workspace", () => {
      const root = resolveWorkspaceRoot();
      const symlinkOutsideToInside = path.join(tempDir, "symlink-into-packages");

      // Create a symlink in tempDir pointing into <root>/packages
      fs.symlinkSync(path.join(root, "packages"), symlinkOutsideToInside);

      // Path appears lexically outside the repository (starts with tempDir),
      // but canonically resolves inside the repository!
      const aliasedDbPath = path.join(symlinkOutsideToInside, "database", "pwn.sqlite");

      expect(() => {
        assertDatabasePathOutsideRepository(aliasedDbPath);
      }).toThrow(/resolves inside the Git repository/);
    });

    it("rejects symlinked database files pointing into the workspace even when the file does not exist yet", () => {
      const root = resolveWorkspaceRoot();
      const symlinkParent = path.join(tempDir, "symlink-to-root");

      fs.symlinkSync(root, symlinkParent);
      const nonExistentDb = path.join(symlinkParent, "new-file-never-created.sqlite");

      expect(() => {
        assertDatabasePathOutsideRepository(nonExistentDb);
      }).toThrow(/resolves inside the Git repository/);
    });

    it("SqlitePrivateHistoryRepository constructor rejects inside-workspace paths", () => {
      const root = resolveWorkspaceRoot();
      const forbiddenDb = path.join(root, "local-leak.sqlite");

      expect(() => {
        new SqlitePrivateHistoryRepository(forbiddenDb);
      }).toThrow(/must reside outside the Git repository/);
    });

    it("SqlitePrivateHistoryRepository constructor in read-only mode also rejects inside-workspace paths", () => {
      const root = resolveWorkspaceRoot();
      const forbiddenDb = path.join(root, "local-leak-ro.sqlite");

      expect(() => {
        new SqlitePrivateHistoryRepository(forbiddenDb, { readOnly: true });
      }).toThrow(/must reside outside the Git repository/);
    });
  });

  describe("getCanonicalPath()", () => {
    it("resolves canonical path for an existing file", () => {
      const testFile = path.join(tempDir, "sample.txt");
      fs.writeFileSync(testFile, "hello");

      const canonical = getCanonicalPath(testFile);
      expect(canonical).toBe(fs.realpathSync(testFile));
    });

    it("resolves canonical path for a non-existent file through existing ancestors", () => {
      const nonExistent = path.join(tempDir, "sub1", "sub2", "file.txt");
      const canonical = getCanonicalPath(nonExistent);

      const expectedBase = fs.realpathSync(tempDir);
      expect(canonical).toBe(path.join(expectedBase, "sub1", "sub2", "file.txt"));
    });
  });
});
