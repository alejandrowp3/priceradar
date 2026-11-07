import type { Metadata } from "next";
import type { ReactNode } from "react";
import { UI_STRINGS_ES_CO } from "@priceradar/domain";

export const metadata: Metadata = {
  title: "PriceRadar Colombia — Inteligencia Automatizada de Precios",
  description: UI_STRINGS_ES_CO.states.disclaimer,
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="es-CO">
      <body
        style={{
          margin: 0,
          backgroundColor: "#0B0C0E",
          color: "#F4F6F8",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}
