/** Index of the row whose vertical center is nearest to `y` (viewport px).
 *  Pure — the TurnRail's scrub gesture maps pointer Y through this. */
export function nearestIndexByY(centers: number[], y: number): number {
  let nearest = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  centers.forEach((center, index) => {
    const distance = Math.abs(center - y);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
  });
  return nearest;
}

export interface RailRowPosition {
  turnId: string;
  turnIndex: number;
  centerY: number;
}

/** The measured rail row nearest to `y`, retaining its logical turn identity. */
export function nearestRailRowByY(rows: RailRowPosition[], y: number): RailRowPosition | undefined {
  const nearestIndex = nearestIndexByY(
    rows.map((row) => row.centerY),
    y,
  );
  return nearestIndex >= 0 ? rows[nearestIndex] : undefined;
}

/**
 * The rail shows only the most recent turns — an unbounded session must not
 * grow an unbounded strip of hairlines. Returns the index of the first turn
 * the rail renders; callers convert between visible ordinals and absolute
 * turn indices by adding it.
 */
export const RAIL_MAX_TURNS = 20;

export function railWindowOffset(totalTurns: number, maxTurns: number = RAIL_MAX_TURNS): number {
  return Math.max(0, totalTurns - maxTurns);
}
