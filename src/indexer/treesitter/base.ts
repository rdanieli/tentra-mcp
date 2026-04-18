export type SupportedLanguage =
  | 'typescript' | 'javascript' | 'python' | 'go' | 'java' | 'rust'

export type DetectedLanguage = SupportedLanguage | 'unknown'

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'variable' | 'type'
export type EdgeType = 'call' | 'method_call' | 'import' | 'inherit' | 'implement' | 'reference'

export interface ExtractedSymbol {
  kind: SymbolKind
  name: string
  qualifiedName: string
  startLine: number
  endLine: number
}

export interface ExtractedEdge {
  fromQualifiedName: string
  toQualifiedName: string | null
  toExternal: string | null
  edgeType: EdgeType
}

export interface ExtractionResult {
  language: DetectedLanguage
  loc: number
  symbols: ExtractedSymbol[]
  edges: ExtractedEdge[]
  parseError: string | null
}

export interface Extractor {
  extract(source: string): ExtractionResult
}
