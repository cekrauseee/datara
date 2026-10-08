// OKLCH conversions use Björn Ottosson's OKLab matrices; sRGB values are 0..1 before encoding.
export type Oklch = { L: number; C: number; h: number }
type Triple = [number, number, number]

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function linearRgb(hex: string): Triple {
  return [1, 3, 5].map((i) => toLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255)) as Triple
}
function linearRgbToOklab([r, g, b]: Triple): Triple {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
function oklabToLinearRgb(L: number, a: number, b: number): Triple {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

export function hexToOklch(hex: string): Oklch {
  const [L, a, b] = linearRgbToOklab(linearRgb(hex))
  const h = (Math.atan2(b, a) * 180) / Math.PI
  return { L, C: Math.hypot(a, b), h: h < 0 ? h + 360 : h }
}

/** Encodes as lowercase sRGB hex, lowering chroma in 0.002 steps until the color is in gamut. */
export function oklchToHex({ L, C, h }: Oklch) {
  const angle = (h * Math.PI) / 180
  const inGamut = (rgb: Triple) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4)
  let chroma = C
  let rgb = oklabToLinearRgb(L, chroma * Math.cos(angle), chroma * Math.sin(angle))
  while (!inGamut(rgb) && chroma > 0) {
    chroma -= 0.002
    rgb = oklabToLinearRgb(L, chroma * Math.cos(angle), chroma * Math.sin(angle))
  }
  return `#${rgb
    .map((c) =>
      Math.round(toGamma(Math.min(1, Math.max(0, c))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** Euclidean distance in OKLab; 0.02 is about the smallest difference noticeable side by side. */
export function deltaE(first: string, second: string) {
  const [L1, a1, b1] = linearRgbToOklab(linearRgb(first))
  const [L2, a2, b2] = linearRgbToOklab(linearRgb(second))
  return Math.hypot(L1 - L2, a1 - a2, b1 - b2)
}

/** WCAG 2 contrast ratio between two sRGB colors. */
export function contrast(first: string, second: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = linearRgb(hex)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [x, y] = [luminance(first), luminance(second)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
