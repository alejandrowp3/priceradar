import Link from "next/link";
import { formatCop } from "@priceradar/domain";
import type { PersistedOpportunityEventRow } from "@priceradar/database";
import { PriceBadge } from "./PriceBadge";

export interface OpportunityCardProps {
  readonly opportunity: PersistedOpportunityEventRow;
}

export function OpportunityCard({ opportunity }: OpportunityCardProps) {
  const isHistoricalLow = opportunity.opportunityType === "HISTORICAL_LOW";
  const isHistoricalDrop = opportunity.opportunityType === "HISTORICAL_DROP";
  const isDeclared = opportunity.opportunityType === "DECLARED_DISCOUNT";

  const borderColor = isHistoricalLow
    ? "rgba(16, 185, 129, 0.4)"
    : isHistoricalDrop
      ? "rgba(16, 185, 129, 0.25)"
      : "var(--border)";

  const formattedDate = new Date(opportunity.detectedAt).toLocaleDateString("es-CO", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      style={{
        backgroundColor: "var(--surface-card)",
        border: `1px solid ${borderColor}`,
        borderRadius: "var(--radius-md)",
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: "1rem",
        transition: "border-color 0.15s ease",
      }}
    >
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.5rem",
            marginBottom: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <PriceBadge opportunityType={opportunity.opportunityType} size="sm" />
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {formattedDate}
          </span>
        </div>

        <Link
          href={`/products/${encodeURIComponent(opportunity.externalProductId)}`}
          style={{
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <h4
            style={{
              fontSize: "0.9375rem",
              fontWeight: 600,
              color: "var(--text-primary)",
              margin: "0 0 0.25rem 0",
              lineHeight: 1.4,
            }}
          >
            {opportunity.productName}
          </h4>
        </Link>
        {opportunity.packagingLabel && (
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {opportunity.packagingLabel}
          </span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          paddingTop: "0.75rem",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div>
          <div
            style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text-primary)" }}
          >
            {formatCop(opportunity.observedPriceCop)}
          </div>
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--text-muted)",
              textDecoration: "line-through",
            }}
          >
            Ref: {formatCop(opportunity.baselinePriceCop)}
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontSize: "0.875rem",
              fontWeight: 700,
              color: isDeclared ? "var(--accent-amber)" : "var(--accent-emerald)",
            }}
          >
            -{opportunity.discountPercentage.toFixed(1)}%
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            Ahorro: {formatCop(opportunity.savingsCop)}
          </div>
        </div>
      </div>
    </div>
  );
}
