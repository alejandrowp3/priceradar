import { UI_STRINGS_ES_CO } from "@priceradar/domain";

export default function HomePage() {
  return (
    <main style={{ maxWidth: "56rem", margin: "0 auto", padding: "3rem 1.5rem" }}>
      <header style={{ marginBottom: "2rem" }}>
        <span
          style={{
            display: "inline-block",
            padding: "0.25rem 0.65rem",
            borderRadius: "999px",
            backgroundColor: "#181C22",
            border: "1px solid #232931",
            color: "#F59E0B",
            fontSize: "0.75rem",
            fontWeight: 600,
          }}
        >
          {UI_STRINGS_ES_CO.states.demoBadge}
        </span>
        <h1 style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>PriceRadar Colombia</h1>
        <p style={{ color: "#9AA4B2", margin: 0 }}>
          {UI_STRINGS_ES_CO.states.disclaimer}
        </p>
      </header>
      <section>
        <h2>{UI_STRINGS_ES_CO.sections.recentOffers}</h2>
        <p style={{ color: "#9AA4B2" }}>
          Fase 0 completada: contratos de dominio, motor determinístico de precios en COP
          y proveedor de demostración verificados.
        </p>
      </section>
    </main>
  );
}
