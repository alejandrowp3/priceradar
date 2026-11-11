import {
  fetchRecentScanRuns,
  fetchSchedulerStatus,
  getReadOnlyDatabase,
} from "../../lib/db";
import { StatCard } from "../../components/StatCard";
import { EmptyState } from "../../components/EmptyState";
import { ProvenanceNotice } from "../../components/ProvenanceNotice";

export const dynamic = "force-dynamic";

export default function SystemStatusPage() {
  const { dbExists, dbPath } = getReadOnlyDatabase();
  const { runs } = fetchRecentScanRuns(20);
  const schedulerStatus = fetchSchedulerStatus();

  const isCloud =
    process.env.NODE_ENV === "production" ||
    process.env.PRICERADAR_ENV === "cloud" ||
    Boolean(process.env.RAILWAY_ENVIRONMENT_NAME) ||
    Boolean(process.env.RAILWAY_ENVIRONMENT_ID) ||
    Boolean(process.env.RAILWAY_SERVICE_ID) ||
    Boolean(process.env.RAILWAY_ENVIRONMENT);
  const hasWebAuth = Boolean(process.env.PRICERADAR_WEB_PASSWORD);
  const allowedHosts =
    process.env.PRICERADAR_ALLOWED_HOSTS ?? "127.0.0.1, localhost (local mode)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Top Notice */}
      <ProvenanceNotice dismissible={true} />

      {/* Page Header */}
      <div>
        <h1
          style={{
            fontSize: "1.75rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            letterSpacing: "-0.025em",
            marginBottom: "0.5rem",
          }}
        >
          Estado del Sistema y Telemetría Cloud
        </h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
          Monitoreo de infraestructura, programador de ejecuciones periódicas e historial
          de escaneos.
        </p>
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "1rem",
        }}
      >
        <StatCard
          title="Salud del Sistema"
          value={dbExists ? "Saludable" : "Inicializando"}
          subtitle={dbExists ? "Base de datos conectada" : "Esperando primera escritura"}
          badge={{
            label: dbExists ? "Operacional" : "Pendiente",
            variant: dbExists ? "signal" : "amber",
          }}
        />
        <StatCard
          title="Programador Cloud"
          value={
            schedulerStatus?.isStale
              ? "Sin Latido (Stale)"
              : schedulerStatus?.isRunning
                ? "Activo"
                : "En Espera"
          }
          subtitle={`Intervalo: cada ${String(schedulerStatus?.intervalMinutes ?? 60)} min`}
          badge={{
            label: schedulerStatus?.isStale
              ? "Desconectado"
              : schedulerStatus?.isRunning
                ? "En ejecución"
                : "Standby",
            variant: schedulerStatus?.isStale
              ? "amber"
              : schedulerStatus?.isRunning
                ? "signal"
                : "neutral",
          }}
        />
        <StatCard
          title="Ejecuciones Totales"
          value={runs.length}
          subtitle="Historial de escaneos recientes"
        />
        <StatCard
          title="Entorno de Ejecución"
          value={isCloud ? "Nube (P5)" : "Local / Híbrido"}
          subtitle={hasWebAuth ? "Acceso HTTPS protegido" : "Modo loopback sin clave"}
        />
      </div>

      {/* Infrastructure & Remote Session Section */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "1.5rem",
        }}
      >
        {/* Remote Session Card */}
        <div
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            padding: "1.25rem",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "1rem",
            }}
          >
            <h2
              style={{
                fontSize: "1rem",
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Sesión Remota y Colector
            </h2>
            <span
              style={{
                fontSize: "0.75rem",
                padding: "0.25rem 0.5rem",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--accent-emerald-subtle)",
                color: "var(--accent-emerald)",
                fontWeight: 600,
              }}
            >
              Milestone 1 Activo
            </span>
          </div>
          <div
            style={{
              fontSize: "0.875rem",
              color: "var(--text-secondary)",
              lineHeight: 1.6,
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            <div>
              <strong style={{ color: "var(--text-primary)" }}>Proveedor activo:</strong>{" "}
              <code>fixture-colombia</code> (Colección determinista de prueba para
              validación cloud).
            </div>
            <div>
              <strong style={{ color: "var(--text-primary)" }}>
                Estado de Rappi Turbo:
              </strong>{" "}
              Sesión remota en espera de autorización del propietario. El trabajador nunca
              intenta resolver CAPTCHAs ni eludir autenticación.
            </div>
            <div>
              <strong style={{ color: "var(--text-primary)" }}>
                Próxima integración:
              </strong>{" "}
              Sincronización segura de sesión mediante{" "}
              <code>pnpm cloud:session-sync</code> tras validación de IP y enrutamiento
              geográfico.
            </div>
          </div>
        </div>

        {/* Database & Deployment Details */}
        <div
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            padding: "1.25rem",
          }}
        >
          <h2
            style={{
              fontSize: "1rem",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "1rem",
            }}
          >
            Detalles de Infraestructura
          </h2>
          <div
            style={{
              fontSize: "0.875rem",
              color: "var(--text-secondary)",
              lineHeight: 1.6,
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            <div>
              <strong style={{ color: "var(--text-primary)" }}>
                Base de datos SQLite:
              </strong>{" "}
              <code style={{ wordBreak: "break-all" }}>{dbPath}</code>
            </div>
            <div>
              <strong style={{ color: "var(--text-primary)" }}>
                Modo de concurrencia:
              </strong>{" "}
              WAL (Write-Ahead Logging) — dashboard en solo-lectura, trabajador con
              transacciones atómicas.
            </div>
            <div>
              <strong style={{ color: "var(--text-primary)" }}>Hosts autorizados:</strong>{" "}
              <code>{allowedHosts}</code>
            </div>
            <div>
              <strong style={{ color: "var(--text-primary)" }}>Seguridad HTTP:</strong>{" "}
              {hasWebAuth
                ? "HTTP Basic Auth habilitado (protegido con contraseña)"
                : "Loopback local (sin contraseña configurada)"}
            </div>
          </div>
        </div>
      </section>

      {/* Recent Scan Runs Table */}
      <section>
        <div style={{ marginBottom: "1rem" }}>
          <h2
            style={{
              fontSize: "1.25rem",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "0.25rem",
            }}
          >
            Historial de Ejecuciones Programadas
          </h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
            Registro auditable de ciclos de recolección ejecutados por el trabajador
            cloud.
          </p>
        </div>

        {runs.length === 0 ? (
          <EmptyState
            title="Sin ciclos de escaneo registrados"
            description="El programador cloud aún no ha completado una ejecución. Se iniciará automáticamente de acuerdo con el intervalo configurado."
          />
        ) : (
          <div
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              overflowX: "auto",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                textAlign: "left",
                fontSize: "0.875rem",
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--border)",
                    backgroundColor: "var(--surface-subtle)",
                    color: "var(--text-secondary)",
                  }}
                >
                  <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                    ID de Ejecución
                  </th>
                  <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                    Fecha (Bogotá)
                  </th>
                  <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>Estado</th>
                  <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                    Observaciones
                  </th>
                  <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                    Oportunidades
                  </th>
                  <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                    Nuevos / Conocidos
                  </th>
                  <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                    Proveedor / Vista
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const startedDate = new Date(run.startedAt).toLocaleString("es-CO", {
                    timeZone: "America/Bogota",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  });

                  const statusColor =
                    run.status === "SUCCEEDED"
                      ? "var(--accent-emerald)"
                      : run.status === "FAILED"
                        ? "var(--accent-rose)"
                        : "var(--accent-amber)";

                  const statusBg =
                    run.status === "SUCCEEDED"
                      ? "var(--accent-emerald-subtle)"
                      : run.status === "FAILED"
                        ? "var(--accent-rose-subtle)"
                        : "var(--accent-amber-subtle)";

                  return (
                    <tr
                      key={run.scanRunId}
                      style={{
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <td style={{ padding: "0.75rem 1rem" }}>
                        <code
                          style={{ fontSize: "0.8125rem", color: "var(--text-primary)" }}
                        >
                          {run.scanRunId}
                        </code>
                      </td>
                      <td
                        style={{
                          padding: "0.75rem 1rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {startedDate}
                      </td>
                      <td style={{ padding: "0.75rem 1rem" }}>
                        <span
                          style={{
                            fontSize: "0.75rem",
                            padding: "0.2rem 0.5rem",
                            borderRadius: "var(--radius-sm)",
                            backgroundColor: statusBg,
                            color: statusColor,
                            fontWeight: 600,
                          }}
                        >
                          {run.status}
                        </span>
                      </td>
                      <td
                        style={{ padding: "0.75rem 1rem", color: "var(--text-primary)" }}
                      >
                        {run.validObservations}{" "}
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          ({run.duplicateRecords} omitidas)
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "0.75rem 1rem",
                          color: "var(--text-primary)",
                          fontWeight: 600,
                        }}
                      >
                        {run.opportunitiesCreated}
                      </td>
                      <td
                        style={{
                          padding: "0.75rem 1rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {run.newProductsDiscovered} / {run.existingProductsObserved}
                      </td>
                      <td
                        style={{
                          padding: "0.75rem 1rem",
                          color: "var(--text-secondary)",
                          fontSize: "0.8125rem",
                        }}
                      >
                        {run.sourceViewLabel ?? run.sourceViewKey ?? run.providerId}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
