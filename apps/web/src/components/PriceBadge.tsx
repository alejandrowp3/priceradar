import type { OpportunityType } from "@priceradar/domain";
import { formatCop, createCopAmount } from "@priceradar/domain";

export interface PriceBadgeProps {
  readonly changeType?:
    "DROPPED" | "INCREASED" | "UNCHANGED" | "FIRST_OBSERVATION" | undefined;
  readonly diffCop?: number | undefined;
  readonly diffPercentage?: number | undefined;
  readonly opportunityType?: OpportunityType | undefined;
  readonly size?: "sm" | "md" | undefined;
}

export function PriceBadge({
  changeType,
  diffCop,
  diffPercentage,
  opportunityType,
  size = "md",
}: PriceBadgeProps) {
  const isSm = size === "sm";
  const padding = isSm ? "0.15rem 0.45rem" : "0.25rem 0.6rem";
  const fontSize = isSm ? "0.7rem" : "0.75rem";

  if (opportunityType) {
    if (opportunityType === "HISTORICAL_LOW") {
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            padding,
            borderRadius: "var(--radius-full)",
            fontSize,
            fontWeight: 700,
            backgroundColor: "rgba(16, 185, 129, 0.15)",
            color: "var(--accent-emerald)",
            border: "1px solid rgba(16, 185, 129, 0.3)",
            letterSpacing: "0.02em",
          }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          Mínimo Histórico
        </span>
      );
    }
    if (opportunityType === "HISTORICAL_DROP") {
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            padding,
            borderRadius: "var(--radius-full)",
            fontSize,
            fontWeight: 600,
            backgroundColor: "rgba(16, 185, 129, 0.12)",
            color: "var(--accent-emerald)",
            border: "1px solid rgba(16, 185, 129, 0.25)",
          }}
        >
          ↓ Baja Histórica
        </span>
      );
    }
    if (opportunityType === "DECLARED_DISCOUNT") {
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            padding,
            borderRadius: "var(--radius-full)",
            fontSize,
            fontWeight: 600,
            backgroundColor: "rgba(245, 158, 11, 0.12)",
            color: "var(--accent-amber)",
            border: "1px solid rgba(245, 158, 11, 0.25)",
          }}
        >
          % Descuento Declarado
        </span>
      );
    }
  }

  if (changeType === "DROPPED") {
    const formattedDiff =
      diffCop !== undefined
        ? formatCop(createCopAmount(Math.round(Math.abs(diffCop))))
        : null;
    const formattedPct =
      diffPercentage !== undefined ? `${Math.abs(diffPercentage).toFixed(1)}%` : null;
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.25rem",
          padding,
          borderRadius: "var(--radius-full)",
          fontSize,
          fontWeight: 600,
          backgroundColor: "rgba(16, 185, 129, 0.12)",
          color: "var(--accent-emerald)",
          border: "1px solid rgba(16, 185, 129, 0.25)",
        }}
      >
        <span aria-hidden="true">↓</span>
        {formattedDiff && <span>-{formattedDiff}</span>}
        {formattedPct && <span style={{ opacity: 0.85 }}>(-{formattedPct})</span>}
        {!formattedDiff && !formattedPct && <span>Baja</span>}
      </span>
    );
  }

  if (changeType === "INCREASED") {
    const formattedDiff =
      diffCop !== undefined
        ? formatCop(createCopAmount(Math.round(Math.abs(diffCop))))
        : null;
    const formattedPct =
      diffPercentage !== undefined ? `${Math.abs(diffPercentage).toFixed(1)}%` : null;
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.25rem",
          padding,
          borderRadius: "var(--radius-full)",
          fontSize,
          fontWeight: 600,
          backgroundColor: "rgba(244, 63, 94, 0.12)",
          color: "var(--accent-rose)",
          border: "1px solid rgba(244, 63, 94, 0.25)",
        }}
      >
        <span aria-hidden="true">↑</span>
        {formattedDiff && <span>+{formattedDiff}</span>}
        {formattedPct && <span style={{ opacity: 0.85 }}>(+{formattedPct})</span>}
        {!formattedDiff && !formattedPct && <span>Alza</span>}
      </span>
    );
  }

  if (changeType === "FIRST_OBSERVATION") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding,
          borderRadius: "var(--radius-full)",
          fontSize,
          fontWeight: 500,
          backgroundColor: "rgba(245, 158, 11, 0.1)",
          color: "var(--accent-amber)",
          border: "1px solid rgba(245, 158, 11, 0.2)",
        }}
      >
        Primera observación
      </span>
    );
  }

  if (changeType === "UNCHANGED") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding,
          borderRadius: "var(--radius-full)",
          fontSize,
          fontWeight: 500,
          backgroundColor: "var(--surface-elevated)",
          color: "var(--text-muted)",
          border: "1px solid var(--border)",
        }}
      >
        Sin cambio
      </span>
    );
  }

  return null;
}
