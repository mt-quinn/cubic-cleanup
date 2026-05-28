// Minimal ambient typings for the `gifenc` library, which ships
// pure-ESM JS with no types. We use a small subset of the API
// from `highlightReelGif.ts`: `GIFEncoder`, `quantize`,
// `applyPalette`. The shapes below mirror the README; the lib's
// actual surface area is larger but the rest is not used.

declare module 'gifenc' {
  // Indexed palette: each entry is [r, g, b, a?].
  export type Palette = Array<[number, number, number] | [number, number, number, number]>

  export interface QuantizeOptions {
    // 'rgb444' | 'rgb565' | 'rgba4444' — controls bit-depth of
    // the quantizer's working color space. `rgba4444` keeps 1-bit
    // alpha for transparency support, which the highlight reel
    // exporter needs so the GIF composites cleanly on dark/light
    // backgrounds.
    format?: 'rgb444' | 'rgb565' | 'rgba4444'
    clearAlpha?: boolean
    clearAlphaThreshold?: number
    clearAlphaColor?: number
    oneBitAlpha?: boolean
  }

  export function quantize(
    rgba: Uint8ClampedArray | Uint8Array,
    maxColors: number,
    options?: QuantizeOptions,
  ): Palette

  export function applyPalette(
    rgba: Uint8ClampedArray | Uint8Array,
    palette: Palette,
    format?: 'rgb444' | 'rgb565' | 'rgba4444',
  ): Uint8Array

  export interface WriteFrameOptions {
    palette?: Palette
    // Centiseconds in the GIF spec, but the lib accepts ms.
    delay?: number
    transparent?: boolean
    transparentIndex?: number
    dispose?: number
    repeat?: number
    first?: boolean
  }

  export interface GIFEncoderInstance {
    writeFrame(
      indexed: Uint8Array,
      width: number,
      height: number,
      options?: WriteFrameOptions,
    ): void
    finish(): void
    bytes(): Uint8Array
    bytesView(): Uint8Array
    reset(): void
  }

  export function GIFEncoder(options?: {
    auto?: boolean
    initialCapacity?: number
  }): GIFEncoderInstance
}
