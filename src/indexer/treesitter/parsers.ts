import Parser from 'tree-sitter'
import TypeScript from 'tree-sitter-typescript'
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import Go from 'tree-sitter-go'
import Java from 'tree-sitter-java'
import Rust from 'tree-sitter-rust'
import { SupportedLanguage, DetectedLanguage } from './base.js'

const EXT_MAP: Record<string, DetectedLanguage> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.rs': 'rust'
}

export function detectLanguage(filePath: string): DetectedLanguage {
  const idx = filePath.lastIndexOf('.')
  if (idx < 0) return 'unknown'
  const ext = filePath.slice(idx).toLowerCase()
  return EXT_MAP[ext] ?? 'unknown'
}

const LANGUAGE_GRAMMARS: Record<SupportedLanguage, unknown> = {
  typescript: TypeScript.typescript,
  javascript: JavaScript,
  python: Python,
  go: Go,
  java: Java,
  rust: Rust
}

export function getParser(lang: SupportedLanguage): Parser | null {
  const grammar = LANGUAGE_GRAMMARS[lang]
  if (!grammar) return null
  const parser = new Parser()
  parser.setLanguage(grammar as Parameters<Parser['setLanguage']>[0])
  return parser
}
