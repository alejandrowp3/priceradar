#!/usr/bin/env node
/**
 * Safe port preflight utility for PriceRadar.
 *
 * Enforces PriceRadar's mandatory local port policy:
 * - Reserved web development / preview / E2E port: 4178
 * - Forbidden ports: 3000, 3001, 3002, 3100, 3101, 4000, 5000, 5173, 8000, 8080
 * - Never kills occupying processes
 * - Never silently falls back to an alternative port
 */

import net from "node:net";
import { fileURLToPath } from "node:url";

export const RESERVED_WEB_PORT = 4178;
export const RESERVED_STORYBOOK_PORT = 6178;
export const RESERVED_DEBUG_PORT = 8178;

export const ALLOWED_PRICERADAR_PORTS = Object.freeze([
  RESERVED_WEB_PORT,
  RESERVED_STORYBOOK_PORT,
  RESERVED_DEBUG_PORT,
]);

export const FORBIDDEN_PORTS = Object.freeze([
  3000, 3001, 3002, 3100, 3101, 4000, 5000, 5173, 8000, 8080,
]);

/**
 * Validates that a candidate port complies with PriceRadar's port isolation policy.
 * @param {number} port
 * @returns {{ valid: boolean; reason?: string }}
 */
export function validatePortPolicy(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return {
      valid: false,
      reason: `Invalid port number "${String(port)}". Port must be an integer between 1 and 65535.`,
    };
  }

  if (FORBIDDEN_PORTS.includes(port)) {
    return {
      valid: false,
      reason: `Port ${port} is explicitly forbidden by PriceRadar's local port isolation policy to prevent collisions with other local projects.`,
    };
  }

  if (!ALLOWED_PRICERADAR_PORTS.includes(port)) {
    return {
      valid: false,
      reason: `Port ${port} is not an approved PriceRadar port. Allowed ports: ${ALLOWED_PRICERADAR_PORTS.join(", ")}.`,
    };
  }

  return { valid: true };
}

/**
 * Probes whether a TCP port is available on a specific host interface without modifying any running process.
 * @param {number} port
 * @param {string} host
 * @returns {Promise<{ available: boolean; code?: string; message?: string }>}
 */
function probeInterface(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", (err) => {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      resolve({
        available: false,
        code,
        message: err.message,
      });
    });

    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => {
        resolve({ available: true });
      });
    });
  });
}

/**
 * Checks whether the target port is free on loopback interfaces (127.0.0.1 and ::1)
 * and complies with PriceRadar's port policy.
 *
 * @param {{ port?: number; host?: string }} [options]
 * @returns {Promise<{ ok: boolean; port: number; host: string; error?: string; code?: string }>}
 */
export async function checkPortAvailability(options = {}) {
  const port = options.port ?? RESERVED_WEB_PORT;
  const host = options.host ?? "127.0.0.1";

  const policy = validatePortPolicy(port);
  if (!policy.valid) {
    return {
      ok: false,
      port,
      host,
      code: "ERR_PORT_POLICY_VIOLATION",
      error: policy.reason,
    };
  }

  const ipv4Probe = await probeInterface(port, host);
  if (!ipv4Probe.available) {
    return {
      ok: false,
      port,
      host,
      code: ipv4Probe.code ?? "EADDRINUSE",
      error:
        `Port ${port} on ${host} is already occupied (${ipv4Probe.code ?? "in use"}). ` +
        `PriceRadar never terminates existing processes or falls back to another port automatically. ` +
        `Inspect the occupying process with: lsof -iTCP:${port} -sTCP:LISTEN -n -P`,
    };
  }

  // Also check IPv6 loopback if checking standard 127.0.0.1 to catch dual-stack listeners on macOS
  if (host === "127.0.0.1") {
    const ipv6Probe = await probeInterface(port, "::1");
    if (!ipv6Probe.available && ipv6Probe.code === "EADDRINUSE") {
      return {
        ok: false,
        port,
        host: "::1",
        code: "EADDRINUSE",
        error:
          `Port ${port} on ::1 (IPv6 loopback) is already occupied (EADDRINUSE). ` +
          `PriceRadar never terminates existing processes or falls back to another port automatically. ` +
          `Inspect the occupying process with: lsof -iTCP:${port} -sTCP:LISTEN -n -P`,
      };
    }
  }

  return {
    ok: true,
    port,
    host,
  };
}

async function runCli() {
  const args = process.argv.slice(2);
  let targetPort = RESERVED_WEB_PORT;
  let targetHost = "127.0.0.1";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--port" && args[i + 1]) {
      targetPort = Number.parseInt(args[i + 1], 10);
      i += 1;
    } else if (arg === "--host" && args[i + 1]) {
      targetHost = args[i + 1];
      i += 1;
    }
  }

  const result = await checkPortAvailability({
    port: targetPort,
    host: targetHost,
  });

  if (!result.ok) {
    console.error(`[PriceRadar Port Preflight] BLOCKED: ${result.error}`);
    process.exit(1);
  }

  console.log(
    `[PriceRadar Port Preflight] OK: Port ${result.port} (${result.host}) is available and policy-compliant.`,
  );
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && currentFilePath === process.argv[1]) {
  runCli().catch((err) => {
    console.error("[PriceRadar Port Preflight] Unexpected error:", err);
    process.exit(1);
  });
}
