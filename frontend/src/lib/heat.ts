import type { MapLayers } from "./api/types";

export type HeatValue = "load" | "noise_n" | "light_n" | "crowd_n";

const METERS_PER_DEGREE = 111320;
const MAX_SEGMENT_M = 40;
const SIGMA_M = 70;
// Below this the blur would be finer than the grid, so it speckles when zoomed out.
const MIN_SIGMA_PX = 14;
const MAX_ALPHA = 150;
// Keep colours on the same 0.33 / 0.66 cut-offs as the low / mid / high labels.
const RAMP_LOW = 0.16;
const RAMP_HIGH = 0.84;

export interface HeatPoints {
  lat: Float64Array;
  lng: Float64Array;
  length: Float32Array;
  value: Float32Array;
}

export interface HeatView {
  // Top-left corner of the canvas.
  west: number;
  north: number;
  pxPerLng: number;
  pxPerLat: number;
  metersPerPx: number;
}

// Road segments as weighted points, so a long road counts for more than a short one.
export function heatPoints(layers: MapLayers, field: HeatValue): HeatPoints {
  const lats: number[] = [];
  const lngs: number[] = [];
  const lengths: number[] = [];
  const values: number[] = [];

  for (const edge of layers.edges.features) {
    const value = edge.properties[field];
    const line = edge.geometry.coordinates;
    for (let i = 1; i < line.length; i++) {
      const [lng0, lat0] = line[i - 1];
      const [lng1, lat1] = line[i];
      const x = (lng1 - lng0) * METERS_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
      const y = (lat1 - lat0) * METERS_PER_DEGREE;
      const meters = Math.hypot(x, y);
      const parts = Math.max(1, Math.ceil(meters / MAX_SEGMENT_M));
      for (let p = 0; p < parts; p++) {
        const t = (p + 0.5) / parts;
        lats.push(lat0 + (lat1 - lat0) * t);
        lngs.push(lng0 + (lng1 - lng0) * t);
        lengths.push(meters / parts);
        values.push(value);
      }
    }
  }

  return {
    lat: Float64Array.from(lats),
    lng: Float64Array.from(lngs),
    length: Float32Array.from(lengths),
    value: Float32Array.from(values),
  };
}

function rgb(hex: string) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function heatRamp(low: string, mid: string, high: string) {
  const stops = [rgb(low), rgb(mid), rgb(high)];
  const ramp = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = (i / 255 - RAMP_LOW) / (RAMP_HIGH - RAMP_LOW);
    const t = Math.min(Math.max(v, 0), 1) * 2;
    const from = t < 1 ? stops[0] : stops[1];
    const to = t < 1 ? stops[1] : stops[2];
    const mix = t < 1 ? t : t - 1;
    for (let c = 0; c < 3; c++) ramp[i * 3 + c] = from[c] + (to[c] - from[c]) * mix;
  }
  return ramp;
}

// Gaussian kernel regression on a coarse grid: each cell shows the weighted average of the
// roads around it. Summing instead would make any dense street look loud, however quiet.
export function drawHeat(
  canvas: HTMLCanvasElement,
  points: HeatPoints,
  view: HeatView,
  ramp: Uint8ClampedArray,
) {
  const sigmaPx = Math.max(SIGMA_M / view.metersPerPx, MIN_SIGMA_PX);
  const sigmaM = sigmaPx * view.metersPerPx;
  const cell = sigmaPx / 2;
  const cols = Math.ceil(canvas.width / cell) + 1;
  const rows = Math.ceil(canvas.height / cell) + 1;

  // sigma is 2 cells here, so 3 sigma reaches 6 cells.
  const radius = 6;
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size * size);
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      kernel[(y + radius) * size + x + radius] = Math.exp(-(x * x + y * y) / 8);
    }
  }

  const weights = new Float32Array(cols * rows);
  const totals = new Float32Array(cols * rows);
  const { lat, lng, length, value } = points;
  for (let i = 0; i < lat.length; i++) {
    const col = Math.round(((lng[i] - view.west) * view.pxPerLng) / cell);
    const row = Math.round(((view.north - lat[i]) * view.pxPerLat) / cell);
    if (col < -radius || row < -radius || col >= cols + radius || row >= rows + radius) continue;
    for (let y = Math.max(-radius, -row); y <= Math.min(radius, rows - 1 - row); y++) {
      for (let x = Math.max(-radius, -col); x <= Math.min(radius, cols - 1 - col); x++) {
        const weight = kernel[(y + radius) * size + x + radius] * length[i];
        const at = (row + y) * cols + col + x;
        weights[at] += weight;
        totals[at] += weight * value[i];
      }
    }
  }

  const grid = document.createElement("canvas");
  grid.width = cols;
  grid.height = rows;
  const gridContext = grid.getContext("2d");
  const context = canvas.getContext("2d");
  if (!gridContext || !context) return;

  const image = gridContext.createImageData(cols, rows);
  for (let at = 0; at < weights.length; at++) {
    const weight = weights[at];
    if (weight === 0) continue;
    const shade = Math.round((totals[at] / weight) * 255);
    const out = at * 4;
    image.data[out] = ramp[shade * 3];
    image.data[out + 1] = ramp[shade * 3 + 1];
    image.data[out + 2] = ramp[shade * 3 + 2];
    // Fades out where there are no roads to average, instead of a hard edge.
    image.data[out + 3] = MAX_ALPHA * (1 - Math.exp(-weight / sigmaM));
  }
  gridContext.putImageData(image, 0, 0);

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(grid, 0, 0, cols * cell, rows * cell);
}
