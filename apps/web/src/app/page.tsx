import Link from "next/link";
import { fetchDashboardSummary } from "../lib/db";
import { StatCard } from "../components/StatCard";
import { ProvenanceNotice } from "../components/ProvenanceNotice";
import { OpportunityCard } from "../components/OpportunityCard";
import { ProductCard } from "../components/ProductCard";
import { EmptyState } from "../components/EmptyState";

export const dynamic = "force-dynamic";

export default function OverviewPage() {
  const { summary, dbExists } = fetchDashboardSummary();

  if (!dbExists || !summary || summary.counts.totalDistinctProducts === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <ProvenanceNotice dismissible={false} />
        <EmptyState
          title="Historial de precios sin observaciones"
          description="Aún no se han persistido observaciones en la base de datos privada SQLite local. Ejecuta una inspección supervisada con 'pnpm rappi:inspect' para comenzar a registrar precios."
        />
      </div>
    );
  }

  const latestObservedDate = summary.latestObservationAt
    ? new Date(summary.latestObservationAt).toLocaleString("es-CO", {
        timeZone: "America/Bogota",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Sin registros";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Top Banner / Provenance Notice */}
      <ProvenanceNotice />

      {/* Main KPI Telemetry Grid */}
      <section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "1rem",
          }}
        >
          <StatCard
            title="Productos Únicos"
            value={summary.counts.totalDistinctProducts}
            subtitle="Catálogo monitoreado"
            badge={{ label: "Activos", variant: "signal" }}
          />
          <StatCard
            title="Observaciones"
            value={summary.counts.totalActiveObservations}
            subtitle="Puntos de precio almacenados"
          />
          <StatCard
            title="Oportunidades"
            value={summary.counts.activeOpportunitiesCount}
            subtitle="Detectadas activas"
            badge={{
              label: `${summary.counts.activeOpportunitiesCount} activas`,
              variant: summary.counts.activeOpportunitiesCount > 0 ? "amber" : "neutral",
            }}
          />
          <StatCard
            title="Mínimos Históricos"
            value={summary.counts.historicalLowsCount}
            subtitle="Mejor precio registrado"
            badge={{
              label: "Histórico",
              variant: summary.counts.historicalLowsCount > 0 ? "emerald" : "neutral",
            }}
          />
          <StatCard
            title="Inspecciones"
            value={summary.counts.totalScanRuns}
            subtitle={`${summary.counts.totalInspectedViews} vistas exploradas`}
          />
          <StatCard
            title="Última Observación"
            value={latestObservedDate}
            subtitle="Frescura de datos locales"
          />
        </div>
      </section>

      {/* Top Opportunities Section */}
      <section>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1rem",
          }}
        >
          <div>
            <h2
              style={{
                fontSize: "1.25rem",
                fontWeight: 700,
                color: "var(--text-primary)",
                margin: 0,
              }}
            >
              Mejores Oportunidades Activas
            </h2>
            <p
              style={{
                fontSize: "0.8125rem",
                color: "var(--text-muted)",
                margin: "0.25rem 0 0 0",
              }}
            >
              Bajas sobre baseline histórico y descuentos promocionales vigentes
            </p>
          </div>
          {summary.counts.activeOpportunitiesCount > 0 && (
            <Link
              href="/opportunities"
              style={{
                fontSize: "0.875rem",
                color: "var(--accent-signal)",
                textDecoration: "none",
                fontWeight: 500,
              }}
            >
              Ver todas ({summary.counts.activeOpportunitiesCount}) →
            </Link>
          )}
        </div>

        {summary.topOpportunities.length > 0 ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: "1rem",
            }}
          >
            {summary.topOpportunities.map((opp) => (
              <OpportunityCard key={opp.opportunityId} opportunity={opp} />
            ))}
          </div>
        ) : (
          <div
            style={{
              padding: "2rem",
              textAlign: "center",
              backgroundColor: "var(--surface)",
              border: "1px dashed var(--border)",
              borderRadius: "var(--radius-md)",
              color: "var(--text-muted)",
              fontSize: "0.875rem",
            }}
          >
            No hay oportunidades activas detectadas en este momento.
          </div>
        )}
      </section>

      {/* Recently Observed Products */}
      <section>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1rem",
          }}
        >
          <div>
            <h2
              style={{
                fontSize: "1.25rem",
                fontWeight: 700,
                color: "var(--text-primary)",
                margin: 0,
              }}
            >
              Productos Observados Recientemente
            </h2>
            <p
              style={{
                fontSize: "0.8125rem",
                color: "var(--text-muted)",
                margin: "0.25rem 0 0 0",
              }}
            >
              Últimas actualizaciones registradas en el historial local
            </p>
          </div>
          <Link
            href="/products"
            style={{
              fontSize: "0.875rem",
              color: "var(--accent-signal)",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Explorar catálogo completo →
          </Link>
        </div>

        {summary.recentlyObservedProducts.length > 0 ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: "1rem",
            }}
          >
            {summary.recentlyObservedProducts.map((p) => (
              <ProductCard key={p.productVariantKey} product={p} />
            ))}
          </div>
        ) : (
          <div
            style={{
              padding: "2rem",
              textAlign: "center",
              backgroundColor: "var(--surface)",
              border: "1px dashed var(--border)",
              borderRadius: "var(--radius-md)",
              color: "var(--text-muted)",
              fontSize: "0.875rem",
            }}
          >
            Sin productos registrados.
          </div>
        )}
      </section>
    </div>
  );
}
