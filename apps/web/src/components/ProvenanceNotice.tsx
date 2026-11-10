"use client";

import { useState } from "react";

export interface ProvenanceNoticeProps {
  readonly dismissible?: boolean;
}

export function ProvenanceNotice({ dismissible = true }: ProvenanceNoticeProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) {
    return null;
  }

  return (
    <div
      style={{
        backgroundColor: "var(--surface-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        padding: "0.875rem 1.25rem",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "1rem",
        fontSize: "0.8125rem",
        lineHeight: 1.5,
        color: "var(--text-secondary)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
        <div
          style={{
            marginTop: "0.125rem",
            width: "1rem",
            height: "1rem",
            borderRadius: "50%",
            backgroundColor: "var(--accent-signal-subtle)",
            color: "var(--accent-signal)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.625rem",
            fontWeight: 700,
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          i
        </div>
        <div>
          <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
            Historial privado de precios:{" "}
          </span>
          Datos recopilados en sesiones supervisadas por el titular. Los precios reflejan
          las observaciones almacenadas localmente en SQLite y no requieren conexión en
          vivo con Rappi ni servidores externos.
        </div>
      </div>
      {dismissible && (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: "1.125rem",
            lineHeight: 1,
            padding: "0.125rem 0.25rem",
            borderRadius: "var(--radius-sm)",
          }}
          aria-label="Cerrar aviso de procedencia"
        >
          ×
        </button>
      )}
    </div>
  );
}
