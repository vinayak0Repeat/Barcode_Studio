/** Physical unit conversion used by the shared label geometry and PDF emitter. */
export const POINTS_PER_INCH = 72;
export const MILLIMETERS_PER_INCH = 25.4;

export function mmToPt(mm: number): number {
  return (mm * POINTS_PER_INCH) / MILLIMETERS_PER_INCH;
}

export function ptToMm(pt: number): number {
  return (pt * MILLIMETERS_PER_INCH) / POINTS_PER_INCH;
}
