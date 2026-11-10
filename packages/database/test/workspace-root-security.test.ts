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

    // 1. Existing directory symlink pointing into workspace
    it("1. rejects an existing directory symlink pointing into the workspace", () => {
      const root = resolveWorkspaceRoot();
      const symlinkOutsideToInside = path.join(tempDir, "symlink-into-packages");
      fs.symlinkSync(path.join(root, "packages"), symlinkOutsideToInside);

      const targetPath = path.join(symlinkOutsideToInside, "database", "pwn.sqlite");
      expect(() => {
        assertDatabasePathOutsideRepository(targetPath);
      }).toThrow(/resolves inside the Git repository/);

      expect(() => {
        new SqlitePrivateHistoryRepository(targetPath);
      }).toThrow(/resolves inside the Git repository/);

      expect(fs.existsSync(path.join(root, "packages", "database", "pwn.sqlite"))).toBe(
        false,
      );
    });

    // 2. Existing file symlink pointing into workspace
    it("2. rejects an existing file symlink pointing into the workspace", () => {
      const root = resolveWorkspaceRoot();
      const realFileInWorkspace = path.join(root, "package.json");
      const symlinkToFile = path.join(tempDir, "alias-package-json.sqlite");
      fs.symlinkSync(realFileInWorkspace, symlinkToFile);

      expect(() => {
        assertDatabasePathOutsideRepository(symlinkToFile);
      }).toThrow(/resolves inside the Git repository/);

      expect(() => {
        new SqlitePrivateHistoryRepository(symlinkToFile);
      }).toThrow(/resolves inside the Git repository/);
    });

    // 3. Dangling file symlink whose destination is a nonexistent file inside workspace (F6-01)
    it("3. rejects a dangling file symlink pointing to a nonexistent file inside the workspace (F6-01)", () => {
      const root = resolveWorkspaceRoot();
      const targetInWorkspace = path.join(root, "private-infiltrate.sqlite");
      const danglingSymlink = path.join(tempDir, "dangling-alias.sqlite");
      fs.symlinkSync(targetInWorkspace, danglingSymlink);

      // Verify prerequisite: target does not exist on disk
      expect(fs.existsSync(targetInWorkspace)).toBe(false);

      expect(() => {
        assertDatabasePathOutsideRepository(danglingSymlink);
      }).toThrow(/resolves inside the Git repository/);

      expect(() => {
        new SqlitePrivateHistoryRepository(danglingSymlink);
      }).toThrow(/resolves inside the Git repository/);

      // Crucial assertion: failed validation must NEVER create files in the workspace!
      expect(fs.existsSync(targetInWorkspace)).toBe(false);
    });

    // 4. Relative symlink to a nonexistent workspace file
    it("4. rejects a relative symlink pointing to a nonexistent workspace file", () => {
      const root = resolveWorkspaceRoot();
      const subDir = path.join(tempDir, "subfolder");
      fs.mkdirSync(subDir, { recursive: true });

      const targetInWorkspace = path.join(root, "relative-target.sqlite");
      const relativeDest = path.relative(subDir, targetInWorkspace);
      const relSymlink = path.join(subDir, "rel-alias.sqlite");
      fs.symlinkSync(relativeDest, relSymlink);

      expect(fs.existsSync(targetInWorkspace)).toBe(false);

      expect(() => {
        assertDatabasePathOutsideRepository(relSymlink);
      }).toThrow(/resolves inside the Git repository/);

      expect(() => {
        new SqlitePrivateHistoryRepository(relSymlink);
      }).toThrow(/resolves inside the Git repository/);

      expect(fs.existsSync(targetInWorkspace)).toBe(false);
    });

    // 5. Cyclic symlinks
    it("5. detects and rejects cyclic symlinks", () => {
      const loop1 = path.join(tempDir, "loop-a.sqlite");
      const loop2 = path.join(tempDir, "loop-b.sqlite");
      fs.symlinkSync(loop2, loop1);
      fs.symlinkSync(loop1, loop2);

      expect(() => {
        assertDatabasePathOutsideRepository(loop1);
      }).toThrow(/cyclic or excessively nested symbolic link detected/);

      expect(() => {
        new SqlitePrivateHistoryRepository(loop1);
      }).toThrow(/cyclic or excessively nested symbolic link detected/);

      // Also self-referential symlink
      const selfLoop = path.join(tempDir, "self-loop.sqlite");
      fs.symlinkSync(selfLoop, selfLoop);

      expect(() => {
        assertDatabasePathOutsideRepository(selfLoop);
      }).toThrow(/cyclic or excessively nested symbolic link detected/);
    });

    // 6. Valid outside-workspace symlink
    it("6. allows a valid symlink whose target is entirely outside the workspace", () => {
      const realTargetOutside = path.join(tempDir, "real-target.sqlite");
      const symlinkOutside = path.join(tempDir, "symlink-outside.sqlite");
      fs.symlinkSync(realTargetOutside, symlinkOutside);

      expect(() => {
        assertDatabasePathOutsideRepository(symlinkOutside);
      }).not.toThrow();
    });

    // 7. Nonexistent ordinary database path outside workspace
    it("7. allows a nonexistent ordinary database path outside the workspace", () => {
      const brandNewOutside = path.join(tempDir, "sub1", "sub2", "brand-new.sqlite");
      expect(fs.existsSync(brandNewOutside)).toBe(false);

      expect(() => {
        assertDatabasePathOutsideRepository(brandNewOutside);
      }).not.toThrow();
    });

    // 8. Existing P2/P3 CLI path behavior
    it("8. preserves default private SQLite storage path outside the workspace", () => {
      const defaultPath = path.join(
        os.homedir(),
        ".local",
        "share",
        "priceradar",
        "private-history.sqlite",
      );

      expect(() => {
        assertDatabasePathOutsideRepository(defaultPath);
      }).not.toThrow();
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
