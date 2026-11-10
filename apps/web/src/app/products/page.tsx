import { fetchCatalogProducts, fetchCoverageReport } from "../../lib/db";
import { ProductCard } from "../../components/ProductCard";
import { FilterBar } from "../../components/FilterBar";
import { Pagination } from "../../components/Pagination";
import { EmptyState } from "../../components/EmptyState";

export const dynamic = "force-dynamic";

interface ProductsPageProps {
  readonly searchParams: Promise<{
    readonly q?: string;
    readonly priceChange?: string;
    readonly corridor?: string;
    readonly sort?: string;
    readonly page?: string;
  }>;
}

const SORT_OPTIONS = [
  { value: "LAST_SEEN_DESC", label: "Última observación" },
  { value: "NAME_ASC", label: "Nombre (A-Z)" },
  { value: "PRICE_ASC", label: "Menor precio" },
  { value: "PRICE_DESC", label: "Mayor precio" },
  { value: "OBSERVATIONS_DESC", label: "Más observaciones" },
];

export default async function ProductsPage({ searchParams }: ProductsPageProps) {
  const params = await searchParams;
  const q = params.q?.trim() || undefined;
  const priceChange =
    (params.priceChange?.trim() as
      "DROPPED" | "INCREASED" | "UNCHANGED" | "FIRST_OBSERVATION") || undefined;
  const corridor = params.corridor?.trim() || undefined;
  const sortBy =
    (params.sort?.trim() as
      | "LAST_SEEN_DESC"
      | "NAME_ASC"
      | "NAME_DESC"
      | "PRICE_ASC"
      | "PRICE_DESC"
      | "OBSERVATIONS_DESC") || "LAST_SEEN_DESC";
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const pageSize = 12;

  const { report } = fetchCoverageReport();
  const corridors = report ? report.views.map((v) => v.viewKey) : [];

  const { result, dbExists } = fetchCatalogProducts({
    ...(q ? { search: q } : {}),
    ...(priceChange ? { priceChange } : {}),
    ...(corridor ? { sourceViewKey: corridor } : {}),
    sortBy,
    page,
    pageSize,
  });

  const totalPages = result ? Math.ceil(result.totalCount / pageSize) : 0;

  function makeHref(p: number) {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (priceChange) sp.set("priceChange", priceChange);
    if (corridor) sp.set("corridor", corridor);
    if (sortBy && sortBy !== "LAST_SEEN_DESC") sp.set("sort", sortBy);
    if (p > 1) sp.set("page", p.toString());
    const str = sp.toString();
    return `/products${str ? `?${str}` : ""}`;
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
          Catálogo Monitoreado
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", margin: 0 }}>
          Productos registrados a lo largo de las sesiones de inspección con su último
          precio observado
        </p>
      </div>

      <FilterBar
        searchPlaceholder="Buscar por nombre, marca o ID de producto..."
        showPriceChangeFilter={true}
        showCorridorFilter={corridors.length > 0}
        corridors={corridors}
        sortOptions={SORT_OPTIONS}
      />

      {!dbExists || !result || result.totalCount === 0 ? (
        <EmptyState
          title="No se encontraron productos"
          description={
            q || priceChange || corridor
              ? "Ningún producto coincide con los filtros aplicados. Prueba ajustando la búsqueda o seleccionando otro pasillo."
              : "No hay productos registrados en el catálogo local."
          }
          actionLabel={q || priceChange || corridor ? "Restablecer filtros" : undefined}
          actionHref={q || priceChange || corridor ? "/products" : undefined}
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
            {result.items.map((prod) => (
              <ProductCard key={prod.productVariantKey} product={prod} />
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
