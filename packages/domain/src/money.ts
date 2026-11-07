import { z } from "zod";

/**
 * Branded type for integer Colombian Pesos (COP).
 * All monetary amounts in PriceRadar must be non-negative safe integers.
 * Floating-point arithmetic for money is strictly forbidden.
 */
export type CopAmount = number & { readonly __brand: "CopAmount" };

export const CopAmountSchema = z
  .number()
  .int("COP amount must be an integer")
  .nonnegative("COP amount must be non-negative")
  .safe("COP amount must be a safe integer")
  .transform((val) => val as CopAmount);

/**
 * Validates and brands an integer COP amount.
 * Rejects floats, negative numbers, NaN, and unsafe integers.
 */
export function createCopAmount(value: number): CopAmount {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `Invalid COP amount "${String(value)}": must be a non-negative safe integer.`,
    );
  }
  return value as CopAmount;
}

export function addCop(a: CopAmount, b: CopAmount): CopAmount {
  return createCopAmount(a + b);
}

export function subtractCop(current: CopAmount, reference: CopAmount): number {
  return current - reference;
}

/**
 * Calculates integer basis points (1% = 100 bps, 100% = 10,000 bps) of savings
 * relative to a baseline price using deterministic integer math (half-up rounding).
 */
export function calculateDiscountBasisPoints(
  currentPrice: CopAmount,
  baselinePrice: CopAmount,
): number {
  if (baselinePrice <= 0 || currentPrice >= baselinePrice) {
    return 0;
  }
  const savings = baselinePrice - currentPrice;
  return Math.round((savings * 10_000) / baselinePrice);
}

/**
 * Converts basis points to whole percentage points for display or coarse comparisons.
 */
export function basisPointsToPercentage(basisPoints: number): number {
  return Math.round(basisPoints / 100);
}

const copFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

/**
 * Formats an integer COP amount using natural Colombian Spanish conventions (`es-CO`).
 */
export function formatCop(amount: CopAmount): string {
  return copFormatter.format(amount);
}
