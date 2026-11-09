import { fetchCoverageReport } from "../../lib/db";
import { StatCard } from "../../components/StatCard";
import { EmptyState } from "../../components/EmptyState";
import { ProvenanceNotice } from "../../components/ProvenanceNotice";

export const dynamic = "force-dynamic";

export default function CoveragePage() {
  const { report, dbExists } = fetchCoverageReport();

  if (!dbExists || !report || report.totalDistinctProducts === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <ProvenanceNotice dismissible={false} />
        <EmptyState
          title="Sin datos de cobertura"
          description="Aún no se han completado inspecciones en diferentes vistas para calcular el informe de cobertura del catálogo."
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      <div>
        <h1
          style={{
            fontSize: "1.75rem",
            fontWeight: 800,
            color: "var(--text-primary)",
            margin: "0 0 0.25rem 0",
          }}
        >
          Cobertura y Descubrimiento del Catálogo
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", margin: 0 }}>
          Supervisión acumulada a través de pasillos y categorías inspeccionadas en Rappi
          Turbo
        </p>
      </div>

      <ProvenanceNotice />

      {/* Coverage KPIs */}
      <section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "1rem",
          }}
        >
          <StatCard
            title="Catálogo Acumulado"
            value={report.totalDistinctProducts}
            subtitle="Productos distintos descubiertos"
            badge={{ label: "Monitoreados", variant: "signal" }}
          />
          <StatCard
            title="Vistas Exploradas"
            value={report.totalInspectedViews}
            subtitle="Pasillos y categorías"
          />
          <StatCard
            title="Total Observaciones"
            value={report.totalActiveObservations}
            subtitle="Historial de puntos de precio"
          />
          <StatCard
            title="Sesiones de Escaneo"
            value={report.totalScanRuns}
            subtitle="Inspecciones supervisadas"
          />
          <StatCard
            title="Productos Rezagados"
            value={report.staleProductsCount}
            subtitle="No vistos en la última sesión"
            badge={{
              label: report.staleProductsCount > 0 ? "Pendientes" : "Al día",
              variant: report.staleProductsCount > 0 ? "amber" : "emerald",
            }}
          />
        </div>
      </section>

      {/* Per-View Breakdown Table */}
      <section>
        <h2
          style={{
            fontSize: "1.25rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: "0 0 0.25rem 0",
          }}
        >
          Desglose por Pasillo / Vista ({report.views.length})
        </h2>
        <p
          style={{
            fontSize: "0.8125rem",
            color: "var(--text-muted)",
            margin: "0 0 1rem 0",
          }}
        >
          Productos únicos y volumen de observaciones registrados en cada sección del
          catálogo
        </p>

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
                <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                  Vista / Pasillo
                </th>
                <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                  Productos Únicos
                </th>
                <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                  Observaciones
                </th>
                <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>Sesiones</th>
                <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                  Último Registro
                </th>
              </tr>
            </thead>
            <tbody>
              {report.views.map((row, idx) => {
                const isLegacy = row.viewKey === "VISTA_DEFAULT";
                const lastDate = new Date(row.lastObservedAt).toLocaleString("es-CO", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });

                return (
                  <tr
                    key={row.viewKey}
                    style={{
                      borderBottom:
                        idx < report.views.length - 1
                          ? "1px solid var(--border)"
                          : "none",
                    }}
                  >
                    <td style={{ padding: "0.75rem 1rem" }}>
                      <div
                        style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                      >
                        <span
                          style={{
                            fontWeight: 600,
                            color: "var(--text-primary)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {row.ownerLabel
                            ? `${row.ownerLabel} (${row.viewKey})`
                            : row.viewKey}
                        </span>
                        {isLegacy && (
                          <span
                            style={{
                              fontSize: "0.7rem",
                              padding: "0.15rem 0.4rem",
                              borderRadius: "var(--radius-full)",
                              backgroundColor: "rgba(245, 158, 11, 0.12)",
                              color: "var(--accent-amber)",
                              border: "1px solid rgba(245, 158, 11, 0.25)",
                            }}
                          >
                            Captura anterior (sin metadatos de vista)
                          </span>
                        )}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: "0.75rem 1rem",
                        fontWeight: 700,
                        color: "var(--text-primary)",
                      }}
                    >
                      {row.distinctProductsCount}
                    </td>
                    <td
                      style={{ padding: "0.75rem 1rem", color: "var(--text-secondary)" }}
                    >
                      {row.totalObservationsCount}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", color: "var(--text-muted)" }}>
                      {row.scanRunsCount}
                    </td>
                    <td style={{ padding: "0.75rem 1rem", color: "var(--text-muted)" }}>
                      {lastDate}
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
