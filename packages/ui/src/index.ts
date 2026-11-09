/**
 * PriceRadar Design System Tokens (Phase P4)
 * Premium financial & retail price telemetry design system.
 */

export const DESIGN_SYSTEM_TOKENS = {
  themes: {
    dark: {
      background: "#0B0C0E",
      backgroundSubtle: "#0F1216",
      surface: "#121519",
      surfaceElevated: "#181C22",
      surfaceCard: "#14171D",
      surfaceHover: "#1C2128",
      textPrimary: "#F4F6F8",
      textSecondary: "#9AA4B2",
      textMuted: "#667085",
      borderSubtle: "#232931",
      borderHover: "#323B47",
      accentEmerald: "#10B981",
      accentEmeraldSubtle: "rgba(16, 185, 129, 0.12)",
      accentAmber: "#F59E0B",
      accentAmberSubtle: "rgba(245, 158, 11, 0.12)",
      accentSignal: "#0EA5E9",
      accentSignalSubtle: "rgba(14, 165, 233, 0.12)",
      accentRose: "#F43F5E",
      accentRoseSubtle: "rgba(244, 63, 94, 0.12)",
      chartGrid: "rgba(255, 255, 255, 0.08)",
      chartLine: "#10B981",
      chartArea: "rgba(16, 185, 129, 0.15)",
      chartPoint: "#F4F6F8",
    },
    light: {
      background: "#FAF8F5",
      backgroundSubtle: "#F4F0EA",
      surface: "#FFFFFF",
      surfaceElevated: "#F2EFE9",
      surfaceCard: "#FFFFFF",
      surfaceHover: "#F7F5F0",
      textPrimary: "#141619",
      textSecondary: "#525866",
      textMuted: "#868C98",
      borderSubtle: "#E4E0D8",
      borderHover: "#D0C9BD",
      accentEmerald: "#047857",
      accentEmeraldSubtle: "rgba(4, 120, 87, 0.10)",
      accentAmber: "#B45309",
      accentAmberSubtle: "rgba(180, 83, 9, 0.10)",
      accentSignal: "#0284C7",
      accentSignalSubtle: "rgba(2, 132, 199, 0.10)",
      accentRose: "#E11D48",
      accentRoseSubtle: "rgba(225, 29, 72, 0.10)",
      chartGrid: "rgba(0, 0, 0, 0.06)",
      chartLine: "#047857",
      chartArea: "rgba(4, 120, 87, 0.12)",
      chartPoint: "#141619",
    },
  },
  typography: {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    fontFamilyMono:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  },
  radii: {
    xs: "4px",
    sm: "6px",
    md: "10px",
    lg: "14px",
    xl: "20px",
    full: "9999px",
  },
  shadows: {
    sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
    md: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
    lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
  },
  transitions: {
    default: "all 0.15s ease-in-out",
  },
} as const;

/**
 * Returns raw CSS defining CSS variables for light & dark themes, typography and reduced-motion.
 */
export function generateCssCustomProperties(): string {
  const d = DESIGN_SYSTEM_TOKENS.themes.dark;
  const l = DESIGN_SYSTEM_TOKENS.themes.light;

  return `
    :root {
      --bg: ${d.background};
      --bg-subtle: ${d.backgroundSubtle};
      --surface: ${d.surface};
      --surface-elevated: ${d.surfaceElevated};
      --surface-card: ${d.surfaceCard};
      --surface-hover: ${d.surfaceHover};
      --text-primary: ${d.textPrimary};
      --text-secondary: ${d.textSecondary};
      --text-muted: ${d.textMuted};
      --border: ${d.borderSubtle};
      --border-hover: ${d.borderHover};
      --accent-emerald: ${d.accentEmerald};
      --accent-emerald-subtle: ${d.accentEmeraldSubtle};
      --accent-amber: ${d.accentAmber};
      --accent-amber-subtle: ${d.accentAmberSubtle};
      --accent-signal: ${d.accentSignal};
      --accent-signal-subtle: ${d.accentSignalSubtle};
      --accent-rose: ${d.accentRose};
      --accent-rose-subtle: ${d.accentRoseSubtle};
      --chart-grid: ${d.chartGrid};
      --chart-line: ${d.chartLine};
      --chart-area: ${d.chartArea};
      --chart-point: ${d.chartPoint};
      --radius-sm: ${DESIGN_SYSTEM_TOKENS.radii.sm};
      --radius-md: ${DESIGN_SYSTEM_TOKENS.radii.md};
      --radius-lg: ${DESIGN_SYSTEM_TOKENS.radii.lg};
      --radius-full: ${DESIGN_SYSTEM_TOKENS.radii.full};
      --font-family: ${DESIGN_SYSTEM_TOKENS.typography.fontFamily};
      --font-mono: ${DESIGN_SYSTEM_TOKENS.typography.fontFamilyMono};
    }

    [data-theme="light"], @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) {
        --bg: ${l.background};
        --bg-subtle: ${l.backgroundSubtle};
        --surface: ${l.surface};
        --surface-elevated: ${l.surfaceElevated};
        --surface-card: ${l.surfaceCard};
        --surface-hover: ${l.surfaceHover};
        --text-primary: ${l.textPrimary};
        --text-secondary: ${l.textSecondary};
        --text-muted: ${l.textMuted};
        --border: ${l.borderSubtle};
        --border-hover: ${l.borderHover};
        --accent-emerald: ${l.accentEmerald};
        --accent-emerald-subtle: ${l.accentEmeraldSubtle};
        --accent-amber: ${l.accentAmber};
        --accent-amber-subtle: ${l.accentAmberSubtle};
        --accent-signal: ${l.accentSignal};
        --accent-signal-subtle: ${l.accentSignalSubtle};
        --accent-rose: ${l.accentRose};
        --accent-rose-subtle: ${l.accentRoseSubtle};
        --chart-grid: ${l.chartGrid};
        --chart-line: ${l.chartLine};
        --chart-area: ${l.chartArea};
        --chart-point: ${l.chartPoint};
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *, ::before, ::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }
  `;
}
