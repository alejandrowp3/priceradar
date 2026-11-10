import Link from "next/link";
import { formatCop } from "@priceradar/domain";
import { fetchProductDetail } from "../../../lib/db";
import { PriceBadge } from "../../../components/PriceBadge";
import { PriceHistoryChart } from "../../../components/PriceHistoryChart";
import { StatCard } from "../../../components/StatCard";
import { EmptyState } from "../../../components/EmptyState";

export const dynamic = "force-dynamic";

interface ProductDetailPageProps {
  readonly params: Promise<{
    readonly id: string;
  }>;
}

export default async function ProductDetailPage({ params }: ProductDetailPageProps) {
  const { id } = await params;
  const decodedId = decodeURIComponent(id);
  const { detail, dbExists } = fetchProductDetail(decodedId);

  if (!dbExists || !detail) {
    return (
      <EmptyState
        title="Producto no encontrado"
        description={`No se encontró ningún producto con el identificador "${decodedId}" en la base de datos local.`}
        actionLabel="Volver al catálogo de productos"
        actionHref="/products"
      />
    );
  }

  const { product, statistics, observations, activeOpportunities } = detail;

  const firstSeenStr = new Date(statistics.firstObservedAt).toLocaleDateString("es-CO", {
    timeZone: "America/Bogota",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const lastSeenStr = new Date(statistics.lastObservedAt).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const priceChange: "DROPPED" | "INCREASED" | "UNCHANGED" | "FIRST_OBSERVATION" =
    statistics.priceDifferenceCop !== undefined
      ? statistics.priceDifferenceCop < 0
        ? "DROPPED"
        : statistics.priceDifferenceCop > 0
          ? "INCREASED"
          : "UNCHANGED"
      : statistics.observationCount <= 1
        ? "FIRST_OBSERVATION"
        : "UNCHANGED";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Breadcrumb navigation */}
      <nav style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
        <Link
          href="/products"
          style={{ color: "var(--accent-signal)", textDecoration: "none" }}
        >
          ← Volver a productos
        </Link>
      </nav>

      {/* Product Hero */}
      <div
        style={{
          backgroundColor: "var(--surface-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "1.75rem",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: "1.5rem",
          }}
        >
          <div style={{ flex: 1, minWidth: "260px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              {activeOpportunities.map((opp) => (
                <PriceBadge
                  key={opp.opportunityId}
                  opportunityType={opp.opportunityType}
                />
              ))}
              <PriceBadge
                changeType={priceChange}
                diffCop={statistics.priceDifferenceCop}
                diffPercentage={statistics.priceDifferencePercentage}
              />
            </div>

            <h1
              style={{
                fontSize: "1.5rem",
                fontWeight: 800,
                color: "var(--text-primary)",
                margin: "0 0 0.5rem 0",
                lineHeight: 1.3,
              }}
            >
              {product.productName}
            </h1>

            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                fontSize: "0.875rem",
                color: "var(--text-secondary)",
                flexWrap: "wrap",
              }}
            >
              {product.brand && (
                <span>
                  Marca:{" "}
                  <strong style={{ color: "var(--text-primary)" }}>
                    {product.brand}
                  </strong>
                </span>
              )}
              {product.packagingLabel && (
                <span>
                  • Empaque: <strong>{product.packagingLabel}</strong>
                </span>
              )}
              <span>
                • ID:{" "}
                <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.8125rem" }}>
                  {product.externalProductId}
                </code>
              </span>
            </div>
          </div>

          <div style={{ textAlign: "right", minWidth: "160px" }}>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--text-muted)",
                marginBottom: "0.25rem",
              }}
            >
              Último precio observado
            </div>
            <div
              style={{ fontSize: "2rem", fontWeight: 800, color: "var(--text-primary)" }}
            >
              {formatCop(statistics.currentPriceCop)}
            </div>
            {statistics.previousPriceCop && (
              <div
                style={{
                  fontSize: "0.8125rem",
                  color: "var(--text-muted)",
                  marginTop: "0.25rem",
                }}
              >
                Anterior: {formatCop(statistics.previousPriceCop)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Price Telemetry KPIs */}
      <section>
        <h2
          style={{
            fontSize: "1.125rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: "0 0 1rem 0",
          }}
        >
          Estadísticas de Precio
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "1rem",
          }}
        >
          <StatCard
            title="Mínimo Registrado"
            value={formatCop(statistics.minPriceCop)}
            subtitle="Mejor precio en historial"
            badge={{ label: "Mín", variant: "emerald" }}
          />
          <StatCard
            title="Máximo Registrado"
            value={formatCop(statistics.maxPriceCop)}
            subtitle="Pico más alto registrado"
            badge={{ label: "Máx", variant: "neutral" }}
          />
          <StatCard
            title="Precio Promedio"
            value={formatCop(statistics.averagePriceCop)}
            subtitle="Media simple de observaciones"
          />
          <StatCard
            title="Total Observaciones"
            value={statistics.observationCount}
            subtitle={
              statistics.hasSufficientHistory
                ? "Historial suficiente (≥2)"
                : "Primera observación registrada"
            }
            badge={{
              label: statistics.hasSufficientHistory ? "Verificado" : "1 sola",
              variant: statistics.hasSufficientHistory ? "signal" : "amber",
            }}
          />
          <StatCard
            title="Primera Vez Visto"
            value={firstSeenStr}
            subtitle="Inicio de monitoreo"
          />
          <StatCard
            title="Última Vez Visto"
            value={lastSeenStr}
            subtitle="Observación más reciente"
          />
        </div>
      </section>

      {/* SVG Price History Chart */}
      <section
        style={{
          backgroundColor: "var(--surface-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "1.5rem",
        }}
      >
        <h2
          style={{
            fontSize: "1.125rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: "0 0 1rem 0",
          }}
        >
          Curva Histórica de Precios
        </h2>
        <PriceHistoryChart
          observations={observations.map((obs, idx) => ({
            pointIndex: idx,
            observedAt: obs.observedAt,
            observedPriceCop: obs.observedPriceCop,
            ...(obs.declaredReferencePriceCop !== undefined
              ? { declaredReferencePriceCop: obs.declaredReferencePriceCop }
              : {}),
            ...(obs.sourceViewLabel !== undefined
              ? { sourceViewLabel: obs.sourceViewLabel }
              : {}),
          }))}
          productName={product.productName}
        />
      </section>

      {/* Observations Timeline Table */}
      <section>
        <h2
          style={{
            fontSize: "1.125rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: "0 0 1rem 0",
          }}
        >
          Línea de Tiempo de Observaciones ({observations.length})
        </h2>
        <div
          style={{
            backgroundColor: "var(--surface-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            overflowX: "auto",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.8125rem",
              textAlign: "left",
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--border)",
                  backgroundColor: "var(--surface-elevated)",
                  color: "var(--text-secondary)",
                }}
              >
                <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>Fecha y Hora</th>
                <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                  Precio Observado
                </th>
                <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                  Precio Referencia
                </th>
                <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                  Pasillo / Vista
                </th>
                <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                  Disponibilidad
                </th>
              </tr>
            </thead>
            <tbody>
              {observations.map((obs, idx) => {
                const dateStr = new Date(obs.observedAt).toLocaleString("es-CO", {
                  timeZone: "America/Bogota",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });
                const availabilityState =
                  obs.availability === "AVAILABLE" || obs.availability === "IN_STOCK"
                    ? { label: "Disponible", color: "var(--accent-emerald)" }
                    : obs.availability === "OUT_OF_STOCK"
                      ? { label: "Agotado", color: "var(--accent-rose)" }
                      : { label: "No especificado", color: "var(--accent-amber)" };
                return (
                  <tr
                    key={obs.presentationId}
                    style={{
                      borderBottom:
                        idx < observations.length - 1
                          ? "1px solid var(--border)"
                          : "none",
                    }}
                  >
                    <td style={{ padding: "0.75rem 1rem", color: "var(--text-primary)" }}>
                      {dateStr}
                    </td>
                    <td
                      style={{
                        padding: "0.75rem 1rem",
                        fontWeight: 700,
                        color: "var(--text-primary)",
                      }}
                    >
                      {formatCop(obs.observedPriceCop)}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", color: "var(--text-muted)" }}>
                      {obs.declaredReferencePriceCop
                        ? formatCop(obs.declaredReferencePriceCop)
                        : "—"}
                    </td>
                    <td
                      style={{ padding: "0.75rem 1rem", color: "var(--text-secondary)" }}
                    >
                      {obs.sourceViewKey === "VISTA_DEFAULT"
                        ? "Captura anterior (sin vista)"
                        : (obs.sourceViewLabel ?? obs.sourceViewKey ?? "—")}
                    </td>
                    <td style={{ padding: "0.75rem 1rem" }}>
                      <span
                        style={{
                          display: "inline-block",
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          backgroundColor: availabilityState.color,
                          marginRight: "0.35rem",
                        }}
                      />
                      {availabilityState.label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
