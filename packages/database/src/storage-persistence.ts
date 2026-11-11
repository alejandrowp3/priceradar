import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type PersistenceTier =
  | "LOCAL_WORKSPACE_STORAGE"
  | "SIMULATED_CI_VOLUME"
  | "RAILWAY_PERSISTENT_VOLUME"
  | "UNVERIFIED_EPHEMERAL_FILESYSTEM";

export type PersistenceEvidenceType =
  "LOCAL_DIRECTORY" | "CI_SIMULATED_TEST_MOUNT" | "RAILWAY_PLATFORM_MOUNT" | "NONE";

export interface VolumeMarkerInfo {
  readonly volumeId: string;
  readonly createdAt: string;
  readonly persistenceTier: PersistenceTier;
  readonly storagePath: string;
  readonly volumeName?: string;
  readonly mountPath?: string;
  readonly hostEnvironment?: string;
}

export interface PersistenceVerificationResult {
  readonly persistenceVerified: boolean;
  readonly persistenceTier: PersistenceTier;
  readonly evidenceType: PersistenceEvidenceType;
  readonly storageDir: string;
  readonly storageDirExists: boolean;
  readonly storageDirWritable: boolean;
  readonly volumeMarker: VolumeMarkerInfo | null;
  readonly isExistingMarker: boolean;
  readonly restartProofVerified: boolean;
  readonly reason?: string;
}

export const VOLUME_MARKER_FILENAME = ".priceradar-volume-marker.json";

function isStorageContainedInMount(storageDir: string, mountPath: string): boolean {
  const resolvedStorage = path.resolve(storageDir);
  const resolvedMount = path.resolve(mountPath);
  return (
    resolvedStorage === resolvedMount ||
    resolvedStorage.startsWith(resolvedMount + path.sep)
  );
}

/**
 * Detects whether the process is executing inside a Railway deployment (`F7-12`).
 * Railway automatically provides runtime environment variables:
 * - RAILWAY_ENVIRONMENT_NAME (e.g. 'production', 'staging')
 * - RAILWAY_ENVIRONMENT_ID
 * - RAILWAY_SERVICE_ID
 * - RAILWAY_VOLUME_NAME
 * - RAILWAY_VOLUME_MOUNT_PATH
 * - RAILWAY_STATIC_URL
 *
 * We also accept RAILWAY_ENVIRONMENT for backward compatibility, but never require users to set it.
 */
export function isRailwayEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.RAILWAY_ENVIRONMENT_NAME ||
    env.RAILWAY_ENVIRONMENT_ID ||
    env.RAILWAY_SERVICE_ID ||
    env.RAILWAY_VOLUME_NAME ||
    env.RAILWAY_VOLUME_MOUNT_PATH ||
    env.RAILWAY_STATIC_URL ||
    env.RAILWAY_ENVIRONMENT,
  );
}

/**
 * Detects whether the current process is executing in a cloud environment (`F7-12`).
 */
export function isCloudDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.PRICERADAR_ENV === "cloud" ||
    isRailwayEnvironment(env) ||
    Boolean(env.RENDER) ||
    Boolean(env.FLY_APP_NAME)
  );
}

/**
 * Validates the persistent storage contract for cloud deployments (`F7-11`, `F7-11A`, `F7-11B`, `F7-12`).
 * Explicitly distinguishes a writable filesystem from a verified persistent volume:
 * - Writable /data in a container without an attached volume is ephemeral and rejected in cloud mode.
 * - Railway persistent volumes require valid mount path validation (RAILWAY_VOLUME_MOUNT_PATH matching storageDir).
 * - Arbitrary volume-name declarations alone do NOT prove mounting (F7-11A).
 * - Simulated CI volumes are strictly restricted to verified CI/test environments (F7-11A).
 * - Marker writes must fail closed upon failure (F7-11B).
 * - Existing markers are strictly validated before trust; corrupted or incomplete markers fail closed (F7-11B).
 * - Known volume identities are never silently replaced (F7-11B).
 * - Automatically detects standard Railway runtime variables (F7-12).
 */
export function verifyStoragePersistenceContract(
  storageDir: string,
  env: NodeJS.ProcessEnv = process.env,
): PersistenceVerificationResult {
  const resolvedDir = path.resolve(storageDir);
  const storageDirExists = fs.existsSync(resolvedDir);

  if (!storageDirExists) {
    return {
      persistenceVerified: false,
      persistenceTier: "UNVERIFIED_EPHEMERAL_FILESYSTEM",
      evidenceType: "NONE",
      storageDir: resolvedDir,
      storageDirExists: false,
      storageDirWritable: false,
      volumeMarker: null,
      isExistingMarker: false,
      restartProofVerified: false,
      reason: `Storage directory does not exist at '${resolvedDir}'. Persistent volume mount missing.`,
    };
  }

  let storageDirWritable = false;
  try {
    fs.accessSync(resolvedDir, fs.constants.W_OK);
    storageDirWritable = true;
  } catch {
    storageDirWritable = false;
  }

  if (!storageDirWritable) {
    return {
      persistenceVerified: false,
      persistenceTier: "UNVERIFIED_EPHEMERAL_FILESYSTEM",
      evidenceType: "NONE",
      storageDir: resolvedDir,
      storageDirExists: true,
      storageDirWritable: false,
      volumeMarker: null,
      isExistingMarker: false,
      restartProofVerified: false,
      reason: `Storage directory at '${resolvedDir}' is not writable. Check mount permissions.`,
    };
  }

  const isCloud = isCloudDeployment(env);

  let persistenceTier: PersistenceTier;
  let evidenceType: PersistenceEvidenceType = "NONE";
  let persistenceVerified = false;
  let volumeName: string | undefined = undefined;
  let mountPath: string | undefined = undefined;

  if (!isCloud) {
    // 1. Local workspace storage
    persistenceTier = "LOCAL_WORKSPACE_STORAGE";
    evidenceType = "LOCAL_DIRECTORY";
    persistenceVerified = true;
  } else if (env.PRICERADAR_PERSISTENCE_TIER === "SIMULATED_CI_VOLUME") {
    // 2. F7-11A: Simulated CI volume strictly confined to CI / test runners
    const isCiOrTest =
      env.CI === "true" || env.NODE_ENV === "test" || Boolean(env.VITEST);

    if (!isCiOrTest) {
      return {
        persistenceVerified: false,
        persistenceTier: "UNVERIFIED_EPHEMERAL_FILESYSTEM",
        evidenceType: "NONE",
        storageDir: resolvedDir,
        storageDirExists: true,
        storageDirWritable: true,
        volumeMarker: null,
        isExistingMarker: false,
        restartProofVerified: false,
        reason:
          "SIMULATED_CI_VOLUME persistence tier is strictly restricted to automated CI and test environments. Production deployments must attach a real platform volume.",
      };
    }

    persistenceTier = "SIMULATED_CI_VOLUME";
    evidenceType = "CI_SIMULATED_TEST_MOUNT";
    persistenceVerified = true;
    volumeName = "simulated-ci-volume";
  } else if (isRailwayEnvironment(env)) {
    // 3. F7-11A, F7-12: Railway deployment validation against platform-reported mount path
    const reportedMountPath =
      env.RAILWAY_VOLUME_MOUNT_PATH ?? env.PRICERADAR_VOLUME_MOUNT_PATH;
    const reportedVolumeName = env.RAILWAY_VOLUME_NAME ?? env.PRICERADAR_VOLUME_NAME;

    if (!reportedMountPath) {
      return {
        persistenceVerified: false,
        persistenceTier: "UNVERIFIED_EPHEMERAL_FILESYSTEM",
        evidenceType: "NONE",
        storageDir: resolvedDir,
        storageDirExists: true,
        storageDirWritable: true,
        volumeMarker: null,
        isExistingMarker: false,
        restartProofVerified: false,
        reason:
          "Railway deployment detected without RAILWAY_VOLUME_MOUNT_PATH. Step 2 (Attach Volume at /data) in the Cloud Deployment Guide is required to attach durable storage.",
      };
    }

    if (!isStorageContainedInMount(resolvedDir, reportedMountPath)) {
      return {
        persistenceVerified: false,
        persistenceTier: "UNVERIFIED_EPHEMERAL_FILESYSTEM",
        evidenceType: "NONE",
        storageDir: resolvedDir,
        storageDirExists: true,
        storageDirWritable: true,
        volumeMarker: null,
        isExistingMarker: false,
        restartProofVerified: false,
        reason: `Storage directory at '${resolvedDir}' does not reside within Railway volume mount path '${reportedMountPath}'. Mismatched persistent storage configuration.`,
      };
    }

    if (!reportedVolumeName) {
      return {
        persistenceVerified: false,
        persistenceTier: "UNVERIFIED_EPHEMERAL_FILESYSTEM",
        evidenceType: "NONE",
        storageDir: resolvedDir,
        storageDirExists: true,
        storageDirWritable: true,
        volumeMarker: null,
        isExistingMarker: false,
        restartProofVerified: false,
        reason:
          "Railway deployment missing volume name identification (RAILWAY_VOLUME_NAME required).",
      };
    }

    persistenceTier = "RAILWAY_PERSISTENT_VOLUME";
    evidenceType = "RAILWAY_PLATFORM_MOUNT";
    persistenceVerified = true;
    volumeName = reportedVolumeName;
    mountPath = reportedMountPath;
  } else if (
    env.PRICERADAR_VOLUME_MOUNT_PATH &&
    env.PRICERADAR_VOLUME_NAME &&
    isStorageContainedInMount(resolvedDir, env.PRICERADAR_VOLUME_MOUNT_PATH)
  ) {
    // 4. Custom cloud platform mount validation
    persistenceTier = "RAILWAY_PERSISTENT_VOLUME";
    evidenceType = "RAILWAY_PLATFORM_MOUNT";
    persistenceVerified = true;
    volumeName = env.PRICERADAR_VOLUME_NAME;
    mountPath = env.PRICERADAR_VOLUME_MOUNT_PATH;
  } else {
    // F7-11A: Arbitrary volume names without mount path verification rejected
    persistenceTier = "UNVERIFIED_EPHEMERAL_FILESYSTEM";
    evidenceType = "NONE";
    persistenceVerified = false;
  }

  if (!persistenceVerified) {
    return {
      persistenceVerified: false,
      persistenceTier,
      evidenceType: "NONE",
      storageDir: resolvedDir,
      storageDirExists: true,
      storageDirWritable: true,
      volumeMarker: null,
      isExistingMarker: false,
      restartProofVerified: false,
      reason: isRailwayEnvironment(env)
        ? `Railway deployment detected without attached persistent volume. Step 2 (Attach Volume at /data) in the Cloud Deployment Guide is required to guarantee durable price history.`
        : `Cloud deployment requires verified persistent volume with valid mount path. Ephemeral container filesystem rejected to prevent data loss.`,
    };
  }

  // F7-11B: Volume marker inspection and validation
  const markerPath = path.join(resolvedDir, VOLUME_MARKER_FILENAME);

  if (fs.existsSync(markerPath)) {
    let parsed: unknown = null;
    try {
      const raw = fs.readFileSync(markerPath, "utf-8");
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      return {
        persistenceVerified: false,
        persistenceTier,
        evidenceType,
        storageDir: resolvedDir,
        storageDirExists: true,
        storageDirWritable: true,
        volumeMarker: null,
        isExistingMarker: false,
        restartProofVerified: false,
        reason: `Corrupted volume marker detected at '${markerPath}': invalid JSON (${parseErr instanceof Error ? parseErr.message : String(parseErr)}). To prevent silent volume identity loss, manual recovery or safe marker reset is required.`,
      };
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).volumeId !== "string" ||
      !(parsed as { volumeId: string }).volumeId.trim() ||
      typeof (parsed as Record<string, unknown>).createdAt !== "string" ||
      isNaN(Date.parse((parsed as { createdAt: string }).createdAt)) ||
      typeof (parsed as Record<string, unknown>).storagePath !== "string" ||
      !(parsed as { storagePath: string }).storagePath.trim() ||
      typeof (parsed as Record<string, unknown>).persistenceTier !== "string"
    ) {
      return {
        persistenceVerified: false,
        persistenceTier,
        evidenceType,
        storageDir: resolvedDir,
        storageDirExists: true,
        storageDirWritable: true,
        volumeMarker: null,
        isExistingMarker: false,
        restartProofVerified: false,
        reason: `Incomplete or malformed volume marker at '${markerPath}': missing or invalid required fields (volumeId, createdAt, storagePath, persistenceTier).`,
      };
    }

    const existingMarker = parsed as VolumeMarkerInfo;
    return {
      persistenceVerified: true,
      persistenceTier,
      evidenceType,
      storageDir: resolvedDir,
      storageDirExists: true,
      storageDirWritable: true,
      volumeMarker: existingMarker,
      isExistingMarker: true,
      restartProofVerified: true,
    };
  }

  // F7-11B: Create new volume marker atomically on first initialization
  const newMarker: VolumeMarkerInfo = {
    volumeId: `vol-${crypto.randomBytes(6).toString("hex")}`,
    createdAt: new Date().toISOString(),
    persistenceTier,
    storagePath: resolvedDir,
    ...(volumeName ? { volumeName } : {}),
    ...(mountPath ? { mountPath } : {}),
    ...(isRailwayEnvironment(env)
      ? {
          hostEnvironment: `railway:${env.RAILWAY_ENVIRONMENT_NAME ?? env.RAILWAY_ENVIRONMENT ?? env.RAILWAY_ENVIRONMENT_ID ?? "production"}`,
        }
      : {}),
  };

  const tmpPath = `${markerPath}.tmp.${String(process.pid)}.${String(Date.now())}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(newMarker, null, 2), "utf-8");
    fs.renameSync(tmpPath, markerPath);
  } catch (err: unknown) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup error
    }
    // F7-11B: Fail closed when marker creation fails. Never report success on failed write!
    return {
      persistenceVerified: false,
      persistenceTier,
      evidenceType,
      storageDir: resolvedDir,
      storageDirExists: true,
      storageDirWritable: true,
      volumeMarker: null,
      isExistingMarker: false,
      restartProofVerified: false,
      reason: `Failed to write persistent volume marker to '${markerPath}': ${err instanceof Error ? err.message : String(err)}. Check directory write permissions.`,
    };
  }

  return {
    persistenceVerified: true,
    persistenceTier,
    evidenceType,
    storageDir: resolvedDir,
    storageDirExists: true,
    storageDirWritable: true,
    volumeMarker: newMarker,
    isExistingMarker: false,
    restartProofVerified: false,
  };
}
