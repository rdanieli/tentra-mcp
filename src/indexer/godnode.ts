export interface GodNodeCandidate {
  qualifiedName: string
  fanIn: number
  fanOut: number
}

export interface GodNodeOptions {
  minTotal: number
  topK: number
}

export function detectGodNodes<T extends GodNodeCandidate>(symbols: T[], opts: GodNodeOptions): T[] {
  return symbols
    .filter((s) => s.fanIn + s.fanOut >= opts.minTotal)
    .sort((a, b) => (b.fanIn + b.fanOut) - (a.fanIn + a.fanOut))
    .slice(0, opts.topK)
}
