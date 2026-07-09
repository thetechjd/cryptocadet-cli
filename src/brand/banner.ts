// CryptoCadet first-run banner. Pure + dependency-free: 24-bit truecolor ANSI, with
// graceful fallbacks to plain text. The tagline is Base-only USDC — the retired v3
// taglines ("multi-chain payment router", "SmartMoney Auto-Bridge") are never printed.

/** Canonical brand colors, sampled from the live site. */
export const BRAND = {
  crypto: '#721DDD', // brand violet (CRYPTO block)
  cryptoBright: '#8A3AE8', // in-terminal lighten for very dark terminals only
  cadet: '#721DDD', // teal accent (CADET block)
  tagline: '#8A8A8A', // dim gray
} as const;

// The two word-blocks are colored independently.
const CRYPTO_ART = [
  ' ██████╗██████╗ ██╗   ██╗██████╗ ████████╗ ██████╗ ',
  '██╔════╝██╔══██╗╚██╗ ██╔╝██╔══██╗╚══██╔══╝██╔═══██╗',
  '██║     ██████╔╝ ╚████╔╝ ██████╔╝   ██║   ██║   ██║',
  '██║     ██╔══██╗  ╚██╔╝  ██╔═══╝    ██║   ██║   ██║',
  '╚██████╗██║  ██║   ██║   ██║        ██║   ╚██████╔╝',
  ' ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚═╝        ╚═╝    ╚═════╝ ',
];
const CADET_ART = [
  ' ██████╗ █████╗ ██████╗ ███████╗████████╗',
  '██╔════╝██╔══██╗██╔══██╗██╔════╝╚══██╔══╝',
  '██║     ███████║██║  ██║█████╗     ██║   ',
  '██║     ██╔══██║██║  ██║██╔══╝     ██║   ',
  '╚██████╗██║  ██║██████╔╝███████╗   ██║   ',
  ' ╚═════╝╚═╝  ╚═╝╚═════╝ ╚══════╝   ██║   ',
];
const TAGLINE = '       USDC payment rails for agents  ·  Base';
export const COMPACT_BANNER = ' CRYPTOCADET · USDC rails for agents on Base';

/** Minimum columns for the full art. Below this we use the compact one-liner. */
export const MIN_FULL_WIDTH = 54;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** True only when the terminal advertises 24-bit color. macOS Terminal.app does NOT — it
 *  silently drops truecolor escapes and renders default (grey), which is why we fall back to
 *  256-color there. iTerm2 / most modern terminals set COLORTERM=truecolor. */
export function truecolorSupported(): boolean {
  const ct = process.env.COLORTERM;
  return ct === 'truecolor' || ct === '24bit';
}

/** Nearest xterm-256 index for an RGB triple: grayscale ramp for near-neutral colors, else the
 *  6×6×6 color cube. Good enough to render the brand violet as violet on 256-color terminals. */
function rgbTo256(r: number, g: number, b: number): number {
  if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const cube = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
  return 16 + 36 * cube(r) + 6 * cube(g) + cube(b);
}

function paint(text: string, hex: string, on: boolean, truecolor = truecolorSupported()): string {
  if (!on) return text;
  const [r, g, b] = hexToRgb(hex);
  const sgr = truecolor ? `38;2;${r};${g};${b}` : `38;5;${rgbTo256(r, g, b)}`;
  return `\x1b[${sgr}m${text}\x1b[0m`;
}

export interface BannerOptions {
  /** override ANSI color (default: auto from TTY / NO_COLOR / CI) */
  color?: boolean;
  /** override terminal width (default: process.stdout.columns) */
  columns?: number;
  /** force the compact one-liner */
  compact?: boolean;
  /** use the in-terminal brightened violet for dark backgrounds */
  bright?: boolean;
  /** emit 24-bit truecolor escapes (default: auto from COLORTERM). When false, falls back to
   *  256-color, which is what non-truecolor terminals like macOS Terminal.app need. */
  truecolor?: boolean;
}

/** True unless output is not a TTY, NO_COLOR is set, or CI is set. */
export function colorSupported(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.CI !== undefined) return false;
  return Boolean(process.stdout.isTTY);
}

/** Render the banner as a string. Never throws; safe in any output mode. */
export function renderBanner(opts: BannerOptions = {}): string {
  const on = opts.color ?? colorSupported();
  const cols = opts.columns ?? process.stdout.columns ?? 80;
  const compact = opts.compact ?? cols < MIN_FULL_WIDTH;
  const tc = opts.truecolor ?? truecolorSupported();

  if (compact) {
    // color only the wordmark; keep the rest plain/dim
    if (!on) return COMPACT_BANNER;
    return ` ${paint('CRYPTOCADET', opts.bright ? BRAND.cryptoBright : BRAND.crypto, true, tc)} · USDC rails for agents on Base`;
  }

  const violet = opts.bright ? BRAND.cryptoBright : BRAND.crypto;
  const crypto = CRYPTO_ART.map((l) => paint(l, violet, on, tc)).join('\n');
  const cadet = CADET_ART.map((l) => paint(l, BRAND.cadet, on, tc)).join('\n');
  const tag = paint(TAGLINE, BRAND.tagline, on, tc);
  return `${crypto}\n${cadet}\n${tag}`;
}
