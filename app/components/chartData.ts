/**
 * Pure chart math for the SVG chart kit (unit tested). ViewBox is always
 * 0 0 100 100 like the reference; strokes are non-scaling via CSS.
 */

export interface Point {
  x: number;
  y: number;
}

/** Max of a numeric series (>= 0), 1 as the floor so division never /0. */
export function seriesMax(values: readonly number[]): number {
  return Math.max(1, ...values);
}

/** x positions for n points spread over 0..100. */
export function xPositions(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [50];
  const step = 100 / (count - 1);
  return Array.from({ length: count }, (_, index) => index * step);
}

/** y positions (100 = bottom) for values scaled against max. */
export function yPositions(values: readonly number[], max: number): number[] {
  return values.map((value) => 100 - (100 * Math.max(0, value)) / max);
}

/** Points in the 0..100 viewBox. */
export function toPoints(values: readonly number[]): Point[] {
  const max = seriesMax(values);
  const xs = xPositions(values.length);
  const ys = yPositions(values, max);
  return xs.map((x, index) => ({ x: round2(x), y: round2(ys[index]!) }));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Polyline SVG path ("M0,50 L50,20 ..."); empty -> "", single point -> dot path. */
export function linePath(values: readonly number[]): string {
  if (values.length === 0) return "";
  const points = toPoints(values);
  return points
    .map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`)
    .join(" ");
}

/** Line path closed down to y=100 for a gradient area fill. */
export function areaPath(values: readonly number[]): string {
  if (values.length === 0) return "";
  const points = toPoints(values);
  if (points.length === 1) {
    const { x, y } = points[0]!;
    return `M${x},${y} L${x},100 L${x},100 Z`;
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const line = points
    .map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`)
    .join(" ");
  return `${line} L${last.x},100 L${first.x},100 Z`;
}

/** Bar heights in % of the tallest bar, with a 6% floor like the reference. */
export function barHeights(values: readonly number[]): number[] {
  const max = seriesMax(values);
  return values.map((value) =>
    Math.max(Math.round((100 * Math.max(0, value)) / max), value > 0 ? 6 : 3),
  );
}

/** Index of the peak value (-1 when there is no positive value). */
export function peakIndex(values: readonly number[]): number {
  let best = -1;
  let bestValue = 0;
  values.forEach((value, index) => {
    if (value > bestValue) {
      bestValue = value;
      best = index;
    }
  });
  return best;
}

/** Ring dash offset for a percent (0..100) on a circle of `radius`. */
export function ringDash(percent: number, radius: number): {
  circumference: number;
  offset: number;
} {
  const clamped = Math.max(0, Math.min(100, percent));
  const circumference = 2 * Math.PI * radius;
  return {
    circumference: round2(circumference),
    offset: round2(circumference * (1 - clamped / 100)),
  };
}

/** Donut arc path for one slice [startPercent, endPercent] on `radius`. */
export function donutSlice(
  startPercent: number,
  endPercent: number,
  radius: number,
): string {
  const center = 50;
  const point = (percent: number) => {
    const angle = 2 * Math.PI * (percent / 100) - Math.PI / 2;
    return {
      x: round2(center + radius * Math.cos(angle)),
      y: round2(center + radius * Math.sin(angle)),
    };
  };
  const start = point(startPercent);
  const end = point(endPercent);
  const largeArc = endPercent - startPercent > 50 ? 1 : 0;
  if (endPercent - startPercent >= 100) {
    // full circle: two arcs
    const mid = point(startPercent + 50);
    return [
      `M${start.x},${start.y}`,
      `A${radius},${radius} 0 0 1 ${mid.x},${mid.y}`,
      `A${radius},${radius} 0 0 1 ${end.x},${end.y}`,
    ].join(" ");
  }
  return `M${start.x},${start.y} A${radius},${radius} 0 ${largeArc} 1 ${end.x},${end.y}`;
}
