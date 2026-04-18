export interface ComplexityResult {
  cyclomatic: number
  cognitive: number
}

const DECISION_TOKENS = /\b(if|else\s+if|for|while|case|catch|\?\s*:)\b|&&|\|\|/g
const NESTING_TOKENS = /\b(if|for|while|catch)\b/g

export function computeComplexity(source: string): ComplexityResult {
  const cyc = 1 + (source.match(DECISION_TOKENS)?.length ?? 0)
  // Very light cognitive heuristic: nesting level-weighted decisions.
  let cognitive = 0
  let depth = 0
  const tokens = source.split(/([{}])/g)
  for (const t of tokens) {
    if (t === '{') depth++
    else if (t === '}') depth = Math.max(0, depth - 1)
    else {
      const matches = t.match(NESTING_TOKENS)
      if (matches) cognitive += matches.length * (1 + depth)
    }
  }
  return { cyclomatic: cyc, cognitive }
}
