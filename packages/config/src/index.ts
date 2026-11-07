export const APP_NAME = "PriceRadar";
export const DEFAULT_LOCALE = "es-CO" as const;
export const DEFAULT_CURRENCY = "COP" as const;

export const RESERVED_PORTS = {
  webDev: 4178,
  webPreview: 4178,
  e2e: 4178,
  storybook: 6178,
  debug: 8178,
} as const;

export const FORBIDDEN_PORTS = [
  3000, 3001, 3002, 3100, 3101, 4000, 5000, 5173, 8000, 8080,
] as const;

export type DataMode = "DEMO" | "LIVE" | "STALE" | "UNAVAILABLE";

export interface WorkerRuntimeConfig {
  readonly maxProductsPerScan: number;
  readonly executionTimeoutMs: number;
  readonly maxConcurrency: number;
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
  readonly targetScanIntervalMinutes: number;
}

export const DEFAULT_WORKER_RUNTIME_CONFIG: WorkerRuntimeConfig = {
  maxProductsPerScan: 150,
  executionTimeoutMs: 240_000,
  maxConcurrency: 2,
  maxRetries: 2,
  baseBackoffMs: 500,
  targetScanIntervalMinutes: 15,
};
