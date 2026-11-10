"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

export interface FilterBarProps {
  readonly searchPlaceholder?: string;
  readonly showOpportunityFilter?: boolean;
  readonly showPriceChangeFilter?: boolean;
  readonly showCorridorFilter?: boolean;
  readonly corridors?: readonly string[];
  readonly sortOptions?: readonly { readonly value: string; readonly label: string }[];
}

export function FilterBar({
  searchPlaceholder = "Buscar por producto, marca o ID...",
  showOpportunityFilter = false,
  showPriceChangeFilter = false,
  showCorridorFilter = false,
  corridors = [],
  sortOptions = [],
}: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentSearch = searchParams.get("q") ?? "";
  const currentOpportunityType = searchParams.get("type") ?? "";
  const currentPriceChange = searchParams.get("priceChange") ?? "";
  const currentCorridor = searchParams.get("corridor") ?? "";
  const currentSort = searchParams.get("sort") ?? "";

  function updateQuery(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (!value) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    // Always reset to page 1 on filter/search change
    params.delete("page");

    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  function handleSearchSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const q = formData.get("q")?.toString().trim() ?? "";
    updateQuery({ q: q || null });
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        marginBottom: "1.5rem",
      }}
    >
      <form
        onSubmit={handleSearchSubmit}
        style={{
          display: "flex",
          gap: "0.5rem",
          width: "100%",
        }}
      >
        <div style={{ position: "relative", flex: 1 }}>
          <input
            type="search"
            name="q"
            defaultValue={currentSearch}
            placeholder={searchPlaceholder}
            style={{
              width: "100%",
              padding: "0.625rem 0.875rem 0.625rem 2.25rem",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              fontSize: "0.875rem",
              boxSizing: "border-box",
              outline: "none",
            }}
          />
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              position: "absolute",
              left: "0.75rem",
              top: "50%",
              transform: "translateY(-50%)",
              pointerEvents: "none",
            }}
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </div>

        <button
          type="submit"
          style={{
            padding: "0.625rem 1rem",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--surface-elevated)",
            border: "1px solid var(--border)",
            color: "var(--text-primary)",
            fontSize: "0.875rem",
            fontWeight: 500,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {isPending ? "..." : "Buscar"}
        </button>

        {currentSearch && (
          <button
            type="button"
            onClick={() => updateQuery({ q: null })}
            style={{
              padding: "0.625rem 0.875rem",
              borderRadius: "var(--radius-md)",
              backgroundColor: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              fontSize: "0.875rem",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            Limpiar
          </button>
        )}
      </form>

      {/* Filter Selects */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {showOpportunityFilter && (
          <select
            value={currentOpportunityType}
            onChange={(e) => updateQuery({ type: e.target.value || null })}
            style={{
              padding: "0.45rem 0.75rem",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              fontSize: "0.8125rem",
              cursor: "pointer",
            }}
          >
            <option value="">Todas las oportunidades</option>
            <option value="HISTORICAL_LOW">Mínimo Histórico</option>
            <option value="HISTORICAL_DROP">Baja Histórica</option>
            <option value="DECLARED_DISCOUNT">Descuento Declarado</option>
          </select>
        )}

        {showPriceChangeFilter && (
          <select
            value={currentPriceChange}
            onChange={(e) => updateQuery({ priceChange: e.target.value || null })}
            style={{
              padding: "0.45rem 0.75rem",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              fontSize: "0.8125rem",
              cursor: "pointer",
            }}
          >
            <option value="">Todos los movimientos</option>
            <option value="DROPPED">Precios a la baja (↓)</option>
            <option value="INCREASED">Precios al alza (↑)</option>
            <option value="UNCHANGED">Sin variación (=)</option>
            <option value="FIRST_OBSERVATION">Primera observación</option>
          </select>
        )}

        {showCorridorFilter && corridors.length > 0 && (
          <select
            value={currentCorridor}
            onChange={(e) => updateQuery({ corridor: e.target.value || null })}
            style={{
              padding: "0.45rem 0.75rem",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              fontSize: "0.8125rem",
              cursor: "pointer",
            }}
          >
            <option value="">Todas las vistas / pasillos</option>
            {corridors.map((c) => (
              <option key={c} value={c}>
                {c === "VISTA_DEFAULT" ? "Captura anterior (sin vista)" : c}
              </option>
            ))}
          </select>
        )}

        {sortOptions.length > 0 && (
          <select
            value={currentSort}
            onChange={(e) => updateQuery({ sort: e.target.value || null })}
            style={{
              padding: "0.45rem 0.75rem",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              fontSize: "0.8125rem",
              cursor: "pointer",
              marginLeft: "auto",
            }}
          >
            {sortOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
