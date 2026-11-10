import { fetchActiveOpportunities } from "../../lib/db";
import { OpportunityCard } from "../../components/OpportunityCard";
import { FilterBar } from "../../components/FilterBar";
import { Pagination } from "../../components/Pagination";
import { EmptyState } from "../../components/EmptyState";
import type { OpportunityType } from "@priceradar/domain";

export const dynamic = "force-dynamic";

interface OpportunitiesPageProps {
  readonly searchParams: Promise<{
    readonly q?: string;
    readonly type?: string;
    readonly sort?: string;
    readonly page?: string;
  }>;
}

const SORT_OPTIONS = [
  { value: "DISCOUNT_DESC", label: "Mayor porcentaje (-%)" },
  { value: "SAVINGS_DESC", label: "Mayor ahorro en COP" },
  { value: "DATE_DESC", label: "Más recientes" },
];

export default async function OpportunitiesPage({
  searchParams,
}: OpportunitiesPageProps) {
  const params = await searchParams;
  const q = params.q?.trim() || undefined;
  const opportunityType = (params.type?.trim() as OpportunityType) || undefined;
  const sortBy =
    (params.sort?.trim() as
      | "DISCOUNT_DESC"
      | "DISCOUNT_ASC"
      | "SAVINGS_DESC"
      | "SAVINGS_ASC"
      | "DATE_DESC"
      | "DATE_ASC") || "DISCOUNT_DESC";
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const pageSize = 12;

  const { result, dbExists } = fetchActiveOpportunities({
    ...(q ? { search: q } : {}),
    ...(opportunityType ? { type: opportunityType } : {}),
    sortBy,
    page,
    pageSize,
  });

  const totalPages = result ? Math.ceil(result.totalCount / pageSize) : 0;

  function makeHref(p: number) {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (opportunityType) sp.set("type", opportunityType);
    if (sortBy && sortBy !== "DISCOUNT_DESC") sp.set("sort", sortBy);
    if (p > 1) sp.set("page", p.toString());
    const str = sp.toString();
    return `/opportunities${str ? `?${str}` : ""}`;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div>
        <h1
          style={{
            fontSize: "1.75rem",
            fontWeight: 800,
            color: "var(--text-primary)",
            margin: "0 0 0.25rem 0",
          }}
        >
          Oportunidades de Compra
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", margin: 0 }}>
          Detección determinística de caídas sobre precios históricos y descuentos sobre
          precio de referencia
        </p>
      </div>

      <FilterBar
        searchPlaceholder="Buscar por producto o marca..."
        showOpportunityFilter={true}
        sortOptions={SORT_OPTIONS}
      />

      {!dbExists || !result || result.totalCount === 0 ? (
        <EmptyState
          title="No se encontraron oportunidades"
          description={
            q || opportunityType
              ? "Ninguna oportunidad activa coincide con los filtros aplicados. Intenta cambiar los criterios de búsqueda."
              : "No hay oportunidades activas registradas en la base de datos."
          }
          actionLabel={q || opportunityType ? "Restablecer filtros" : undefined}
          actionHref={q || opportunityType ? "/opportunities" : undefined}
        />
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: "1rem",
            }}
          >
            {result.items.map((opp) => (
              <OpportunityCard key={opp.opportunityId} opportunity={opp} />
            ))}
          </div>

          <Pagination
            page={page}
            totalPages={totalPages}
            totalItems={result.totalCount}
            pageSize={pageSize}
            makeHref={makeHref}
          />
        </>
      )}
    </div>
  );
}
