import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type PersistenceTier =
  | "LOCAL_WORKSPACE_STORAGE"
  | "SIMULATED_CI_VOLUME"
  | "RAILWAY_PERSISTENT_VOLUME"
  | "UNVERIFIED_EPHEMERAL_FILESYSTEM";

export interface VolumeMarkerInfo {
  readonly volumeId: string;
  readonly createdAt: string;
  readonly persistenceTier: PersistenceTier;
  readonly storagePath: string;
  readonly volumeName?: string;
  readonly hostEnvironment?: string;
}

export interface PersistenceVerificationResult {
  readonly persistenceVerified: boolean;
  readonly persistenceTier: PersistenceTier;
  readonly storageDir: string;
  readonly storageDirExists: boolean;
  readonly storageDirWritable: boolean;
  readonly volumeMarker: VolumeMarkerInfo | null;
  readonly isExistingMarker: boolean;
  readonly reason?: string;
}

export const VOLUME_MARKER_FILENAME = ".priceradar-volume-marker.json";

/**
 * Validates the persistent storage contract for cloud deployments (`F7-11`).
 * Explicitly distinguishes a writable filesystem from a verified persistent volume:
 * - Writable /data in a container without an attached volume is ephemeral and rejected in cloud mode.
 * - Railway persistent volumes are verified via RAILWAY_VOLUME_NAME / RAILWAY_VOLUME_MOUNT_PATH / PRICERADAR_VOLUME_NAME.
 * - Simulated CI volumes are explicitly recognized via PRICERADAR_PERSISTENCE_TIER="SIMULATED_CI_VOLUME".
 * - Atomic volume marker files (.priceradar-volume-marker.json) establish durable volume identity across restarts.
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
      storageDir: resolvedDir,
      storageDirExists: false,
      storageDirWritable: false,
      volumeMarker: null,
      isExistingMarker: false,
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
      storageDir: resolvedDir,
      storageDirExists: true,
      storageDirWritable: false,
      volumeMarker: null,
      isExistingMarker: false,
      reason: `Storage directory at '${resolvedDir}' is not writable. Check mount permissions.`,
    };
  }

  const isCloud =
    env.PRICERADAR_ENV === "cloud" ||
    Boolean(env.RAILWAY_ENVIRONMENT) ||
    Boolean(env.RENDER) ||
    Boolean(env.FLY_APP_NAME);

  let persistenceTier: PersistenceTier;
  let persistenceVerified = false;
  let volumeName: string | undefined = undefined;

  if (!isCloud) {
    persistenceTier = "LOCAL_WORKSPACE_STORAGE";
    persistenceVerified = true;
  } else if (env.PRICERADAR_PERSISTENCE_TIER === "SIMULATED_CI_VOLUME") {
    persistenceTier = "SIMULATED_CI_VOLUME";
    persistenceVerified = true;
    volumeName = "simulated-ci-volume";
  } else if (env.RAILWAY_ENVIRONMENT) {
    volumeName =
      env.RAILWAY_VOLUME_NAME ||
      env.PRICERADAR_VOLUME_NAME ||
      (env.RAILWAY_VOLUME_MOUNT_PATH ? "railway-data" : undefined);

    if (volumeName) {
      persistenceTier = "RAILWAY_PERSISTENT_VOLUME";
      persistenceVerified = true;
    } else {
      persistenceTier = "UNVERIFIED_EPHEMERAL_FILESYSTEM";
      persistenceVerified = false;
    }
  } else if (env.PRICERADAR_VOLUME_NAME) {
    volumeName = env.PRICERADAR_VOLUME_NAME;
    persistenceTier = "RAILWAY_PERSISTENT_VOLUME";
    persistenceVerified = true;
  } else {
    persistenceTier = "UNVERIFIED_EPHEMERAL_FILESYSTEM";
    persistenceVerified = false;
  }

  const markerPath = path.join(resolvedDir, VOLUME_MARKER_FILENAME);
  let existingMarker: VolumeMarkerInfo | null = null;

  if (fs.existsSync(markerPath)) {
    try {
      const raw = fs.readFileSync(markerPath, "utf-8");
      existingMarker = JSON.parse(raw) as VolumeMarkerInfo;
    } catch {
      existingMarker = null;
    }
  }

  if (!persistenceVerified) {
    return {
      persistenceVerified: false,
      persistenceTier,
      storageDir: resolvedDir,
      storageDirExists: true,
      storageDirWritable: true,
      volumeMarker: existingMarker,
      isExistingMarker: existingMarker !== null,
      reason: env.RAILWAY_ENVIRONMENT
        ? `Railway deployment detected without attached persistent volume. Step 2 (Attach Volume at /data) in the Cloud Deployment Guide is required to guarantee durable price history.`
        : `Cloud deployment requires verified persistent volume. Ephemeral container filesystem rejected to prevent data loss.`,
    };
  }

  // If a marker already exists, re-use its volumeId and creation timestamp across container restart
  if (existingMarker && existingMarker.volumeId) {
    return {
      persistenceVerified: true,
      persistenceTier,
      storageDir: resolvedDir,
      storageDirExists: true,
      storageDirWritable: true,
      volumeMarker: existingMarker,
      isExistingMarker: true,
    };
  }

  // Create new volume marker atomically on first initialization
  const newMarker: VolumeMarkerInfo = {
    volumeId: `vol-${crypto.randomBytes(6).toString("hex")}`,
    createdAt: new Date().toISOString(),
    persistenceTier,
    storagePath: resolvedDir,
    ...(volumeName ? { volumeName } : {}),
    ...(env.RAILWAY_ENVIRONMENT
      ? { hostEnvironment: `railway:${env.RAILWAY_ENVIRONMENT}` }
      : {}),
  };

  try {
    const tmpPath = `${markerPath}.tmp.${String(process.pid)}.${String(Date.now())}`;
    fs.writeFileSync(tmpPath, JSON.stringify(newMarker, null, 2), "utf-8");
    fs.renameSync(tmpPath, markerPath);
  } catch (err: unknown) {
    // If write fails, log and proceed with in-memory marker
    console.error(
      `Warning: could not write volume marker file to '${markerPath}': ${String(err)}`,
    );
  }

  return {
    persistenceVerified: true,
    persistenceTier,
    storageDir: resolvedDir,
    storageDirExists: true,
    storageDirWritable: true,
    volumeMarker: newMarker,
    isExistingMarker: false,
  };
}
