import Link from "next/link";
import type { ReactNode } from "react";

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly actionLabel?: string | undefined;
  readonly actionHref?: string | undefined;
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionHref,
}: EmptyStateProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "3.5rem 1.5rem",
        borderRadius: "var(--radius-lg)",
        backgroundColor: "var(--surface)",
        border: "1px dashed var(--border)",
        color: "var(--text-secondary)",
      }}
    >
      {icon ? (
        <div
          style={{
            marginBottom: "1rem",
            color: "var(--text-muted)",
          }}
        >
          {icon}
        </div>
      ) : (
        <div
          style={{
            width: "3rem",
            height: "3rem",
            borderRadius: "50%",
            backgroundColor: "var(--surface-elevated)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "1rem",
            color: "var(--text-muted)",
          }}
          aria-hidden="true"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>
      )}
      <h3
        style={{
          fontSize: "1.125rem",
          fontWeight: 600,
          color: "var(--text-primary)",
          margin: "0 0 0.5rem 0",
        }}
      >
        {title}
      </h3>
      <p
        style={{
          fontSize: "0.875rem",
          maxWidth: "28rem",
          margin: "0 0 1.5rem 0",
          lineHeight: 1.5,
        }}
      >
        {description}
      </p>
      {actionLabel && actionHref && (
        <Link
          href={actionHref}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.5rem 1rem",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--surface-elevated)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
            textDecoration: "none",
            fontSize: "0.875rem",
            fontWeight: 500,
          }}
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
