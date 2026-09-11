/**
 * Theme tokens for canvas/SVG consumers. The palette lives as `H S% L%`
 * triplets on the document root (light/dark theme CSS + agent theme
 * overrides), which `hsl(var(--x))` resolves in stylesheets — but canvas
 * gradients and SVG attributes need concrete color values, so these helpers
 * read and convert the tokens at call time. Callers keep a hardcoded
 * fallback for missing/unparsable tokens.
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Reads a root-level `H S% L%` custom property as RGB; null when absent. */
export function cssVarRgb(variable: string): RgbColor | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return hslTripletToRgb(raw);
}

/** `rgba(R, G, B, ` prefix — the caller appends opacity and the closing paren. */
export function rgbaPrefix(color: RgbColor): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, `;
}

export function mixRgb(a: RgbColor, b: RgbColor): RgbColor {
  return {
    r: Math.round((a.r + b.r) / 2),
    g: Math.round((a.g + b.g) / 2),
    b: Math.round((a.b + b.b) / 2),
  };
}

function hslTripletToRgb(raw: string): RgbColor | null {
  const match = raw.match(/^(-?[\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%$/);
  if (!match) {
    return null;
  }
  const h = ((Number.parseFloat(match[1]) % 360) + 360) % 360;
  const s = Number.parseFloat(match[2]) / 100;
  const l = Number.parseFloat(match[3]) / 100;

  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const secondary = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const base = l - chroma / 2;

  let rgb: [number, number, number];
  if (h < 60) {
    rgb = [chroma, secondary, 0];
  } else if (h < 120) {
    rgb = [secondary, chroma, 0];
  } else if (h < 180) {
    rgb = [0, chroma, secondary];
  } else if (h < 240) {
    rgb = [0, secondary, chroma];
  } else if (h < 300) {
    rgb = [secondary, 0, chroma];
  } else {
    rgb = [chroma, 0, secondary];
  }
  return {
    r: Math.round((rgb[0] + base) * 255),
    g: Math.round((rgb[1] + base) * 255),
    b: Math.round((rgb[2] + base) * 255),
  };
}
