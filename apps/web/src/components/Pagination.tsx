import Link from "next/link";

export interface PaginationProps {
  readonly page: number;
  readonly totalPages: number;
  readonly totalItems: number;
  readonly pageSize: number;
  readonly makeHref: (page: number) => string;
}

export function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  makeHref,
}: PaginationProps) {
  if (totalPages <= 1) {
    return null;
  }

  const startItem = Math.min((page - 1) * pageSize + 1, totalItems);
  const endItem = Math.min(page * pageSize, totalItems);

  const prevHref = page > 1 ? makeHref(page - 1) : null;
  const nextHref = page < totalPages ? makeHref(page + 1) : null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "1rem",
        padding: "1rem 0",
        borderTop: "1px solid var(--border)",
        fontSize: "0.875rem",
        color: "var(--text-secondary)",
      }}
    >
      <div>
        Mostrando <strong style={{ color: "var(--text-primary)" }}>{startItem}</strong> a{" "}
        <strong style={{ color: "var(--text-primary)" }}>{endItem}</strong> de{" "}
        <strong style={{ color: "var(--text-primary)" }}>{totalItems}</strong> resultados
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {prevHref ? (
          <Link
            href={prevHref}
            style={{
              padding: "0.375rem 0.75rem",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              textDecoration: "none",
              fontSize: "0.8125rem",
              fontWeight: 500,
            }}
          >
            ← Anterior
          </Link>
        ) : (
          <span
            style={{
              padding: "0.375rem 0.75rem",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--surface-elevated)",
              border: "1px solid transparent",
              color: "var(--text-muted)",
              fontSize: "0.8125rem",
              cursor: "not-allowed",
            }}
          >
            ← Anterior
          </span>
        )}

        <span style={{ padding: "0 0.5rem", fontSize: "0.8125rem" }}>
          Página {page} de {totalPages}
        </span>

        {nextHref ? (
          <Link
            href={nextHref}
            style={{
              padding: "0.375rem 0.75rem",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              textDecoration: "none",
              fontSize: "0.8125rem",
              fontWeight: 500,
            }}
          >
            Siguiente →
          </Link>
        ) : (
          <span
            style={{
              padding: "0.375rem 0.75rem",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--surface-elevated)",
              border: "1px solid transparent",
              color: "var(--text-muted)",
              fontSize: "0.8125rem",
              cursor: "not-allowed",
            }}
          >
            Siguiente →
          </span>
        )}
      </div>
    </div>
  );
}
