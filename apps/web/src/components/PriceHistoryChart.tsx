"use client";

import { useState } from "react";
import { formatCop, createCopAmount } from "@priceradar/domain";
import type { CopAmount } from "@priceradar/domain";

export interface ChartPricePoint {
  readonly pointIndex: number;
  readonly observedAt: string;
  readonly observedPriceCop: CopAmount;
  readonly declaredReferencePriceCop?: CopAmount;
  readonly sourceViewLabel?: string;
}

export interface PriceHistoryChartProps {
  readonly observations: readonly ChartPricePoint[];
  readonly productName: string;
}

export function PriceHistoryChart({ observations, productName }: PriceHistoryChartProps) {
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);

  if (observations.length === 0) {
    return (
      <div
        style={{
          padding: "2rem",
          textAlign: "center",
          color: "var(--text-muted)",
          backgroundColor: "var(--surface)",
          borderRadius: "var(--radius-md)",
          border: "1px dashed var(--border)",
          fontSize: "0.875rem",
        }}
      >
        No hay observaciones registradas para este producto.
      </div>
    );
  }

  if (observations.length === 1) {
    const obs = observations[0];
    if (!obs) {
      return null;
    }
    const singleObsDate = new Date(obs.observedAt).toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      dateStyle: "medium",
      timeStyle: "short",
    });
    return (
      <div
        style={{
          padding: "2rem",
          textAlign: "center",
          color: "var(--text-secondary)",
          backgroundColor: "var(--surface)",
          borderRadius: "var(--radius-md)",
          border: "1px dashed var(--border)",
        }}
      >
        <div
          style={{
            fontSize: "1.5rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            marginBottom: "0.5rem",
          }}
        >
          {formatCop(obs.observedPriceCop)}
        </div>
        <p style={{ margin: "0 0 0.5rem 0", fontSize: "0.875rem" }}>
          Historial insuficiente para graficar tendencia (se requiere al menos una segunda
          observación en un momento diferente).
        </p>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          Observado el {singleObsDate} (Colombia)
        </span>
      </div>
    );
  }

  // Chart dimensions
  const width = 640;
  const height = 240;
  const paddingLeft = 65;
  const paddingRight = 25;
  const paddingTop = 25;
  const paddingBottom = 40;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  // Sorted chronologically (oldest to newest for plotting left-to-right)
  const sorted = [...observations].sort(
    (a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime(),
  );

  const prices = sorted.map((o) => o.observedPriceCop as number);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  // Price range padding (at least 10% or minimum 500 COP)
  const rawDiff = maxPrice - minPrice;
  const yPadding = rawDiff === 0 ? Math.max(minPrice * 0.1, 500) : rawDiff * 0.15;
  const yMin = Math.max(0, Math.floor(minPrice - yPadding));
  const yMax = Math.ceil(maxPrice + yPadding);
  const yRange = yMax - yMin || 1;

  // Time-proportional calculation on X-axis (Minor correction 1)
  const firstObs = sorted[0];
  const lastObs = sorted[sorted.length - 1];
  const firstTime = firstObs ? new Date(firstObs.observedAt).getTime() : 0;
  const lastTime = lastObs ? new Date(lastObs.observedAt).getTime() : 0;
  const timeSpan = lastTime - firstTime;

  // Calculate coordinates for points
  const points = sorted.map((obs, idx) => {
    let x: number;
    if (timeSpan > 0) {
      const timeRatio = (new Date(obs.observedAt).getTime() - firstTime) / timeSpan;
      x = paddingLeft + timeRatio * chartWidth;
    } else {
      x =
        paddingLeft +
        (sorted.length > 1 ? (idx / (sorted.length - 1)) * chartWidth : chartWidth / 2);
    }
    const normalizedY = ((obs.observedPriceCop as number) - yMin) / yRange;
    const y = paddingTop + chartHeight - normalizedY * chartHeight;
    return { x, y, obs, idx };
  });

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (!firstPoint || !lastPoint) {
    return null;
  }

  const pathD = points.reduce((acc, pt, i) => {
    return i === 0 ? `M ${pt.x} ${pt.y}` : `${acc} L ${pt.x} ${pt.y}`;
  }, "");

  const areaD = `${pathD} L ${lastPoint.x} ${paddingTop + chartHeight} L ${firstPoint.x} ${paddingTop + chartHeight} Z`;

  // Y-axis ticks (3 ticks: min, mid, max)
  const yTicks = [
    { value: yMin, y: paddingTop + chartHeight },
    { value: Math.round((yMin + yMax) / 2), y: paddingTop + chartHeight / 2 },
    { value: yMax, y: paddingTop },
  ];

  const activePoint =
    activePointIndex !== null ? (points[activePointIndex] ?? null) : null;

  return (
    <div style={{ position: "relative", width: "100%", overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{
          width: "100%",
          maxWidth: "100%",
          height: "auto",
          display: "block",
          overflow: "visible",
        }}
        role="img"
        aria-label={`Historial proporcional de precios para ${productName}`}
      >
        <title>{`Historial de precios para ${productName}`}</title>
        <desc>{`Gráfico de línea proporcional en el tiempo (America/Bogota) con ${observations.length} observaciones entre ${formatCop(createCopAmount(minPrice))} y ${formatCop(createCopAmount(maxPrice))}`}</desc>

        {/* Horizontal grid lines */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={paddingLeft}
              y1={tick.y}
              x2={width - paddingRight}
              y2={tick.y}
              stroke="var(--border)"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
            <text
              x={paddingLeft - 8}
              y={tick.y + 4}
              textAnchor="end"
              fill="var(--text-muted)"
              fontSize="10"
              fontFamily="var(--font-mono, monospace)"
            >
              {formatCop(createCopAmount(tick.value))}
            </text>
          </g>
        ))}

        {/* Area fill */}
        <path d={areaD} fill="var(--chart-area)" opacity="0.4" />

        {/* Trend line */}
        <path
          d={pathD}
          fill="none"
          stroke="var(--chart-line)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Data points */}
        {points.map((pt) => {
          const isSelected = activePointIndex === pt.idx;
          const formattedObsDate = new Date(pt.obs.observedAt).toLocaleDateString(
            "es-CO",
            {
              timeZone: "America/Bogota",
              month: "short",
              day: "numeric",
            },
          );

          return (
            <g key={pt.idx}>
              <circle
                cx={pt.x}
                cy={pt.y}
                r={isSelected ? 6 : 4}
                fill={isSelected ? "var(--accent-emerald)" : "var(--chart-point)"}
                stroke="var(--bg)"
                strokeWidth="2"
                style={{ cursor: "pointer", transition: "r 0.15s ease" }}
                onMouseEnter={() => setActivePointIndex(pt.idx)}
                onMouseLeave={() => setActivePointIndex(null)}
                onFocus={() => setActivePointIndex(pt.idx)}
                onBlur={() => setActivePointIndex(null)}
                tabIndex={0}
                role="button"
                aria-label={`Observación ${pt.idx + 1}: ${formatCop(pt.obs.observedPriceCop)} el ${formattedObsDate}`}
              />

              {/* X-axis date labels for first and last, or intermediate if spaced */}
              {(pt.idx === 0 || pt.idx === points.length - 1) && (
                <text
                  x={pt.x}
                  y={paddingTop + chartHeight + 18}
                  textAnchor={pt.idx === 0 ? "start" : "end"}
                  fill="var(--text-muted)"
                  fontSize="10"
                >
                  {formattedObsDate}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Caption indicating proportional timeline */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "0.75rem",
          color: "var(--text-muted)",
          marginTop: "0.25rem",
          padding: "0 0.25rem",
        }}
      >
        <span>Eje temporal proporcional (hora legal de Colombia • America/Bogota)</span>
        <span>{observations.length} observaciones registradas</span>
      </div>

      {/* Active point tooltip card */}
      {activePoint && (
        <div
          style={{
            position: "absolute",
            top: "0.5rem",
            right: "0.5rem",
            backgroundColor: "var(--surface-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: "0.5rem 0.75rem",
            fontSize: "0.75rem",
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <div
            style={{
              fontWeight: 700,
              color: "var(--text-primary)",
              fontSize: "0.875rem",
            }}
          >
            {formatCop(activePoint.obs.observedPriceCop)}
          </div>
          {activePoint.obs.declaredReferencePriceCop && (
            <div style={{ color: "var(--text-muted)", textDecoration: "line-through" }}>
              Ref: {formatCop(activePoint.obs.declaredReferencePriceCop)}
            </div>
          )}
          <div style={{ color: "var(--text-secondary)", marginTop: "0.25rem" }}>
            {new Date(activePoint.obs.observedAt).toLocaleString("es-CO", {
              timeZone: "America/Bogota",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
          {activePoint.obs.sourceViewLabel && (
            <div
              style={{
                color: "var(--accent-signal)",
                fontSize: "0.7rem",
                marginTop: "0.15rem",
              }}
            >
              Pasillo: {activePoint.obs.sourceViewLabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
