import Link from "next/link";
import { formatCop } from "@priceradar/domain";
import type { CatalogProductSummaryItem } from "@priceradar/database";
import { PriceBadge } from "./PriceBadge";

export interface ProductCardProps {
  readonly product: CatalogProductSummaryItem;
}

export function ProductCard({ product }: ProductCardProps) {
  const formattedDate = new Date(product.lastObservedAt).toLocaleDateString("es-CO", {
    timeZone: "America/Bogota",
    month: "short",
    day: "numeric",
  });

  const priceChange: "DROPPED" | "INCREASED" | "UNCHANGED" | "FIRST_OBSERVATION" =
    product.priceDifferenceCop !== undefined
      ? product.priceDifferenceCop < 0
        ? "DROPPED"
        : product.priceDifferenceCop > 0
          ? "INCREASED"
          : "UNCHANGED"
      : product.observationCount <= 1
        ? "FIRST_OBSERVATION"
        : "UNCHANGED";

  return (
    <div
      style={{
        backgroundColor: "var(--surface-card)",
        border: "1px solid var(--border)",
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.375rem",
              flexWrap: "wrap",
            }}
          >
            {product.activeOpportunity ? (
              <PriceBadge opportunityType={product.activeOpportunity.type} size="sm" />
            ) : (
              <PriceBadge
                changeType={priceChange}
                diffCop={product.priceDifferenceCop}
                diffPercentage={product.priceDifferencePercentage}
                size="sm"
              />
            )}
            {product.isSyntheticDemo && (
              <span
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  padding: "0.125rem 0.375rem",
                  borderRadius: "var(--radius-sm)",
                  backgroundColor: "rgba(148, 163, 184, 0.15)",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border)",
                }}
              >
                [DEMO SINTÉTICO]
              </span>
            )}
          </div>

          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {product.observationCount} {product.observationCount === 1 ? "obs" : "obs"}
          </span>
        </div>

        <Link
          href={`/products/${encodeURIComponent(product.productVariantKey)}`}
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
            {product.productName}
          </h4>
        </Link>

        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            fontSize: "0.75rem",
            color: "var(--text-muted)",
            flexWrap: "wrap",
          }}
        >
          {product.brand && <span>{product.brand}</span>}
          {product.brand && product.packagingLabel && <span>•</span>}
          {product.packagingLabel && <span>{product.packagingLabel}</span>}
        </div>
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
            {formatCop(product.latestPriceCop)}
          </div>
          {product.previousPriceCop && (
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--text-muted)",
              }}
            >
              Previo: {formatCop(product.previousPriceCop)}
            </div>
          )}
        </div>

        <div style={{ textAlign: "right" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {formattedDate}
          </span>
        </div>
      </div>
    </div>
  );
}
