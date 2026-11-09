import type { ReactNode } from "react";

export interface StatCardProps {
  readonly title: string;
  readonly value: string | number;
  readonly subtitle?: string;
  readonly badge?: {
    readonly label: string;
    readonly variant?: "emerald" | "amber" | "signal" | "neutral";
  };
  readonly icon?: ReactNode;
}

export function StatCard({ title, value, subtitle, badge, icon }: StatCardProps) {
  const badgeStyles = {
    emerald: {
      bg: "var(--accent-emerald-subtle)",
      color: "var(--accent-emerald)",
      border: "rgba(16, 185, 129, 0.25)",
    },
    amber: {
      bg: "var(--accent-amber-subtle)",
      color: "var(--accent-amber)",
      border: "rgba(245, 158, 11, 0.25)",
    },
    signal: {
      bg: "var(--accent-signal-subtle)",
      color: "var(--accent-signal)",
      border: "rgba(14, 165, 233, 0.25)",
    },
    neutral: {
      bg: "var(--surface-elevated)",
      color: "var(--text-secondary)",
      border: "var(--border)",
    },
  }[badge?.variant ?? "neutral"];

  return (
    <div
      style={{
        backgroundColor: "var(--surface-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: "0.75rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontSize: "0.8125rem",
            fontWeight: 500,
            color: "var(--text-secondary)",
            letterSpacing: "0.01em",
          }}
        >
          {title}
        </span>
        {icon && (
          <div style={{ color: "var(--text-muted)", display: "flex" }}>{icon}</div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
        <span
          style={{
            fontSize: "1.75rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            lineHeight: 1.15,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
        {badge && (
          <span
            style={{
              fontSize: "0.6875rem",
              fontWeight: 600,
              padding: "0.125rem 0.375rem",
              borderRadius: "var(--radius-xs)",
              backgroundColor: badgeStyles.bg,
              color: badgeStyles.color,
              border: `1px solid ${badgeStyles.border}`,
            }}
          >
            {badge.label}
          </span>
        )}
      </div>

      {subtitle && (
        <span
          style={{
            fontSize: "0.75rem",
            color: "var(--text-muted)",
            lineHeight: 1.3,
          }}
        >
          {subtitle}
        </span>
      )}
    </div>
  );
}
