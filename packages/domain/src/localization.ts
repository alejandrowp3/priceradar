import type { OpportunityType } from "./entities.ts";

export const OPPORTUNITY_LABELS_ES_CO: Record<OpportunityType, string> = {
  DECLARED_DISCOUNT: "Descuento anunciado",
  HISTORICAL_DROP: "Bajada de precio",
  HISTORICAL_LOW: "Mínimo registrado",
  POTENTIAL_ANOMALY: "Posible error de precio",
};

export const UI_STRINGS_ES_CO = {
  navigation: {
    home: "Inicio",
    explore: "Explorar ofertas",
    stats: "Estadísticas",
    howItWorks: "Cómo funciona",
    admin: "Administración",
  },
  sections: {
    recentOffers: "Ofertas recientes",
    potentialAnomalies: "Posibles errores de precio",
    priceHistory: "Historial de precios",
    lowestRecordedPrice: "Precio más bajo registrado",
    lastUpdated: "Última actualización",
    viewInStore: "Ver en la tienda",
  },
  states: {
    demoBadge: "Datos de demostración",
    liveBadge: "Datos en vivo",
    staleBadge: "Datos desactualizados",
    unavailableBadge: "Fuente no disponible",
    emptyOpportunities: "No encontramos oportunidades recientes",
    disclaimer: "Los precios pueden variar según la tienda y tu ubicación",
  },
} as const;
