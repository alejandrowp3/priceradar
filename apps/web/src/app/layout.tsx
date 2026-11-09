import type { Metadata } from "next";
import type { ReactNode } from "react";
import { generateCssCustomProperties } from "@priceradar/ui";
import { Header } from "../components/Header";

export const metadata: Metadata = {
  title: "PriceRadar Colombia — Inteligencia Privada de Precios",
  description:
    "Dashboard local de inteligencia de precios para Rappi Turbo Colombia basado en historial privado SQLite.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  const cssTokens = generateCssCustomProperties();

  return (
    <html lang="es-CO" data-theme="dark">
      <head>
        <style dangerouslySetInnerHTML={{ __html: cssTokens }} />
      </head>
      <body
        style={{
          margin: 0,
          backgroundColor: "var(--bg)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-family)",
          WebkitFontSmoothing: "antialiased",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Header />
        <main
          style={{
            flex: 1,
            maxWidth: "72rem",
            width: "100%",
            margin: "0 auto",
            padding: "2rem 1rem",
            boxSizing: "border-box",
          }}
        >
          {children}
        </main>
        <footer
          style={{
            borderTop: "1px solid var(--border)",
            backgroundColor: "var(--surface)",
            padding: "1.5rem 1rem",
            textAlign: "center",
            fontSize: "0.75rem",
            color: "var(--text-muted)",
          }}
        >
          <div style={{ maxWidth: "72rem", margin: "0 auto" }}>
            PriceRadar Colombia • Almacenamiento privado local en SQLite (solo lectura) •
            Moneda: COP
          </div>
        </footer>
      </body>
    </html>
  );
}
