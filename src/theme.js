/**
 * Visual tokens. Colour is assigned by the job it does, not by taste:
 *
 *   magnitude (Jacobi constant, delta-V)  -> one sequential hue, blue
 *   identity  (departure / arrival / arc) -> fixed categorical slots, never cycled
 *   state     (lunar impact)              -> the reserved status palette
 *
 * The three categorical slots in use were validated all-pairs against the dark
 * surface (#1a1a19): worst CVD deltaE 9.4, worst normal-vision deltaE 20.9,
 * all >= 3:1 contrast.
 */

export const ink = {
  page: '#0d0d0d',
  surface: '#1a1a19',
  surfaceRaised: '#232321',
  primary: '#ffffff',
  secondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  border: 'rgba(255,255,255,0.10)',
};

/** Identity slots. Order is fixed; a fourth entity gets a style, not a hue. */
export const series = {
  departure: '#d95926', // slot 2, orange
  arrival: '#199e70',   // slot 3, aqua
  transfer: '#3987e5',  // slot 1, blue
  transferAlt: '#9ec5f4', // same hue, lighter step — the comparison solver
};

/** Reserved state colours. Always shipped with a label, never colour alone. */
export const status = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

/**
 * Sequential blue ramp, light -> dark. On a dark surface the darkest steps
 * recede into the background, so magnitude scales run from step 600 (low) to
 * step 100 (high) and nothing drops below ~2:1 contrast.
 */
export const blueRamp = [
  '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5',
  '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb',
];

const hexToRgb = (h) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

const RAMP_RGB = blueRamp.map(hexToRgb);

/**
 * Sample the sequential ramp at t in [0,1] with linear interpolation between
 * steps. Returns [r,g,b] in 0..1, ready for a three.js colour attribute.
 */
export function ramp(t) {
  const x = Math.min(1, Math.max(0, t)) * (RAMP_RGB.length - 1);
  const i = Math.min(RAMP_RGB.length - 2, Math.floor(x));
  const w = x - i;
  const a = RAMP_RGB[i], b = RAMP_RGB[i + 1];
  return [a[0] + w * (b[0] - a[0]), a[1] + w * (b[1] - a[1]), a[2] + w * (b[2] - a[2])];
}

/** CSS colour for the same ramp, for the heatmap and legends. */
export function rampCss(t) {
  const [r, g, b] = ramp(t);
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

/** A CSS linear-gradient covering the full ramp, for legend bars. */
export const rampGradient = `linear-gradient(to right, ${blueRamp.join(', ')})`;
