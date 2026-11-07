# PriceRadar — Visual Design System Specification

## 1. Design Principles

- **Precision & Analytical Clarity:** High-density financial and retail price telemetry without visual clutter, fake urgency, or decorative AI glow.
- **Honest Data Provenance:** Immediate visual distinction between `"Datos de demostración"` (`DEMO`), verified historical drops, and unverified retailer reference discounts.
- **Colombian Localization (`es-CO`):** Natural Colombian Spanish labels, `COP` integer currency formatting (`$ 480.000`), and clear date/time presentation.
- **Accessibility Target:** WCAG 2.2 AA contrast ratios, full keyboard navigation, semantic landmarks, and `prefers-reduced-motion` compliance.

## 2. Color Tokens (`@priceradar/ui`)

### Dark Theme (Default Analytical View)

- Background Primary: `#0B0C0E`
- Surface Primary: `#121519`
- Surface Elevated: `#181C22`
- Text Primary: `#F4F6F8`
- Text Secondary: `#9AA4B2`
- Border Subtle: `#232931`
- Accent Emerald (Verified Savings / Historical Low): `#10B981`
- Accent Amber (Demo Provenance / Potential Anomaly Warning): `#F59E0B`
- Accent Signal Blue (Declared Discount / Navigation): `#0EA5E9`

### Light Theme (Warm Editorial View)

- Background Primary: `#FAF8F5`
- Surface Primary: `#FFFFFF`
- Surface Elevated: `#F2EFE9`
- Text Primary: `#141619`
- Text Secondary: `#525866`
- Border Subtle: `#E4E0D8`
- Accent Emerald: `#047857`
- Accent Amber: `#B45309`
- Accent Signal Blue: `#0284C7`
