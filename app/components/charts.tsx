import { useEffect, useState, type ReactNode } from "react";
import {
  areaPath,
  barHeights,
  linePath,
  peakIndex,
  ringDash,
  toPoints,
} from "./chartData";

/**
 * SVG chart kit reproducing the reference dashboard's hand-rolled charts:
 * viewBox 0 0 100 100, non-scaling strokes, yellow accent, no library
 * (safe inside the Shopify admin iframe; no window access at render time).
 */

const GRID_LINES = [25, 50, 75];

export function ChartSvg({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      // The element's HEIGHT must come from CSS (.bs-chart/.bs-sparkline):
      // an SVG with a 1:1 viewBox and width:100% otherwise grows into a
      // giant square (one spike then dwarfs everything).
      style={{ width: "100%", height: "100%", display: "block" }}
    >
      {children}
    </svg>
  );
}

function GridLines() {
  return (
    <>
      {GRID_LINES.map((y) => (
        <line
          key={y}
          x1={0}
          x2={100}
          y1={y}
          y2={y}
          stroke="var(--bs-track)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
}

/** Clean line chart (reference line view). */
export function LineChart({
  values,
  label,
  color = "var(--bs-charcoal)",
}: {
  values: number[];
  label: string;
  color?: string;
}) {
  const path = linePath(values);
  return (
    <ChartSvg label={label} className="bs-chart">
      <GridLines />
      {values.length === 1 ? (
        <circle
          cx={50}
          cy={toPoints(values)[0]!.y}
          r={1.6}
          fill={color}
        />
      ) : (
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </ChartSvg>
  );
}

/** Area chart with the reference's soft gradient fill. */
export function AreaChart({
  values,
  label,
  color = "#b98a00",
  className = "bs-chart",
}: {
  values: number[];
  label: string;
  color?: string;
  className?: string;
}) {
  const gradientId = `bs-area-${label.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <ChartSvg label={label} className={className}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <GridLines />
      <path d={areaPath(values)} fill={`url(#${gradientId})`} />
      <path
        d={linePath(values)}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </ChartSvg>
  );
}

/** Tiny inline sparkline for stat cards. */
export function Sparkline({
  values,
  label,
  color = "var(--bs-accent-ink)",
}: {
  values: number[];
  label: string;
  color?: string;
}) {
  return (
    <ChartSvg label={label} className="bs-sparkline" >
      <path
        d={linePath(values)}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </ChartSvg>
  );
}

export interface BarDatum {
  label: string;
  value: number;
  /** Extra rows inside the hover tooltip pill. */
  breakdown?: Array<{ name: string; count: number }>;
}

/** Rounded vertical bars with the peak highlighted in yellow + tooltip. */
export function BarChart({ data, label }: { data: BarDatum[]; label: string }) {
  const heights = barHeights(data.map((item) => item.value));
  const peak = peakIndex(data.map((item) => item.value));
  return (
    <div className="bs-bars" role="img" aria-label={label}>
      {data.map((item, index) => (
        <div
          className={`bs-bar-col${index === peak ? " bs-bar-peak" : ""}`}
          key={`${index}-${item.label}`}
        >
          <span className="bs-bar-tip" aria-hidden="true">
            <b className="bs-bar-tip-count">{item.value.toLocaleString()}</b>
            {item.breakdown?.filter((row) => row.count > 0).map((row) => (
              <span className="bs-bar-tip-row" key={row.name}>
                {row.name}: {row.count}
              </span>
            ))}
          </span>
          <span className="bs-bar" style={{ height: `${heights[index]}%` }} />
          <span className="bs-bar-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Radial progress ring with tick marks (reference today_ring). */
export function RadialProgress({
  percent,
  centerValue,
  centerLabel,
  centerSub,
  label,
}: {
  percent: number;
  centerValue: string;
  centerLabel: string;
  centerSub?: string;
  label: string;
}) {
  const radius = 42;
  const { circumference, offset } = ringDash(percent, radius);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const ticks = Array.from({ length: 60 }, (_, index) => {
    const angle = (2 * Math.PI * index) / 60;
    return {
      x1: 50 + 46 * Math.cos(angle),
      y1: 50 + 46 * Math.sin(angle),
      x2: 50 + 48.5 * Math.cos(angle),
      y2: 50 + 48.5 * Math.sin(angle),
    };
  });
  return (
    <div className="bs-ring-wrap" role="img" aria-label={label}>
      <div className="bs-ring-box">
        <svg viewBox="0 0 100 100" className="bs-ring-svg" aria-hidden="true">
          {ticks.map((tick, index) => (
            <line
              key={index}
              x1={tick.x1.toFixed(2)}
              y1={tick.y1.toFixed(2)}
              x2={tick.x2.toFixed(2)}
              y2={tick.y2.toFixed(2)}
              stroke="var(--bs-line-strong)"
              strokeWidth={0.6}
              opacity={0.6}
            />
          ))}
          <circle
            cx={50}
            cy={50}
            r={radius}
            fill="none"
            stroke="var(--bs-track)"
            strokeWidth={5}
          />
          <circle
            cx={50}
            cy={50}
            r={radius}
            fill="none"
            stroke="var(--bs-accent)"
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={ready ? offset : circumference}
            style={{ transition: "stroke-dashoffset 0.9s ease" }}
            transform="rotate(-90 50 50)"
          />
        </svg>
        <div className="bs-ring-center">
          <span className="bs-ring-value">{centerValue}</span>
          <span className="bs-ring-label">{centerLabel}</span>
          {centerSub && <span className="bs-ring-sub">{centerSub}</span>}
        </div>
      </div>
    </div>
  );
}

/** Donut chart (coverage split). */
export function DonutChart({
  slices,
  label,
}: {
  slices: Array<{ name: string; value: number; color: string }>;
  label: string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  let cursor = 0;
  const arcs = slices.map((slice) => {
    const start = total > 0 ? (100 * cursor) / total : 0;
    cursor += slice.value;
    const end = total > 0 ? (100 * cursor) / total : 0;
    return { ...slice, start, end };
  });
  return (
    <div className="bs-donut-wrap" role="img" aria-label={label}>
      <div className="bs-ring-box">
        <svg viewBox="0 0 100 100" className="bs-ring-svg" aria-hidden="true">
          {arcs.map((arc) =>
            arc.end - arc.start > 0.1 ? (
              <path
                key={arc.name}
                d={donutArcPath(arc.start, arc.end)}
                fill="none"
                stroke={arc.color}
                strokeWidth={10}
                strokeLinecap="butt"
              />
            ) : null,
          )}
        </svg>
        <div className="bs-ring-center">
          <span className="bs-ring-value">{total.toLocaleString()}</span>
          <span className="bs-ring-label">{label}</span>
        </div>
      </div>
      <ul className="bs-donut-legend">
        {slices.map((slice) => (
          <li key={slice.name}>
            <i className="bs-dot" style={{ background: slice.color }} />
            {slice.name}
            <b className="bs-num">{slice.value.toLocaleString()}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Local arc helper (chartData.donutSlice returns a filled path; for a
// stroked arc we draw along the circle).
function donutArcPath(startPercent: number, endPercent: number): string {
  const radius = 42;
  const point = (percent: number) => {
    const angle = 2 * Math.PI * (percent / 100) - Math.PI / 2;
    return {
      x: (50 + radius * Math.cos(angle)).toFixed(2),
      y: (50 + radius * Math.sin(angle)).toFixed(2),
    };
  };
  const start = point(startPercent);
  const end = point(endPercent);
  const largeArc = endPercent - startPercent > 50 ? 1 : 0;
  if (endPercent - startPercent >= 99.9) {
    const mid = point(startPercent + 50);
    return `M${start.x},${start.y} A${radius},${radius} 0 1 1 ${mid.x},${mid.y} A${radius},${radius} 0 1 1 ${end.x},${end.y}`;
  }
  return `M${start.x},${start.y} A${radius},${radius} 0 ${largeArc} 1 ${end.x},${end.y}`;
}
