export interface ChromiumReadinessResult {
  readonly isReady: boolean;
  readonly browserVersion?: string;
  readonly executablePath?: string;
  readonly error?: string;
}

/**
 * Diagnostic checker for Playwright Chromium readiness (`F7-04`).
 * Launches headless Chromium and validates that the browser binary and system dependencies are functioning.
 */
export async function checkChromiumReadiness(): Promise<ChromiumReadinessResult> {
  try {
    // Dynamic import to avoid hard crashes in environments without playwright installed
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const browserVersion = browser.version();
    const executablePath = chromium.executablePath();
    await browser.close();

    return {
      isReady: true,
      browserVersion,
      executablePath,
    };
  } catch (err: unknown) {
    return {
      isReady: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

if (
  process.argv[1]?.endsWith("chromium-readiness.ts") ||
  process.argv[1]?.endsWith("chromium-readiness.js")
) {
  checkChromiumReadiness().then((res) => {
    console.log(JSON.stringify(res, null, 2));
    if (!res.isReady) {
      process.exit(1);
    }
  });
}
