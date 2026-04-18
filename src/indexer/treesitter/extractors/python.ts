import { SyntaxNode } from 'tree-sitter'
import { getParser } from '../parsers.js'
import { Extractor, ExtractionResult, ExtractedSymbol, ExtractedEdge } from '../base.js'

const FILE_OWNER = '<file>'

export class PythonExtractor implements Extractor {
  extract(source: string): ExtractionResult {
    const parser = getParser('python')!
    const tree = parser.parse(source)
    const root = tree.rootNode
    if (root.hasError) {
      return { language: 'python', loc: countLoc(source), symbols: [], edges: [], parseError: 'tree-sitter reported syntax errors' }
    }
    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    walk(root, null, symbols, edges)
    return { language: 'python', loc: countLoc(source), symbols, edges, parseError: null }
  }
}

function countLoc(s: string): number { return s.split('\n').filter((l) => l.trim().length > 0).length }

function walk(node: SyntaxNode, owner: string | null, symbols: ExtractedSymbol[], edges: ExtractedEdge[]): void {
  if (node.type === 'import_statement' || node.type === 'import_from_statement') {
    const dottedName = node.descendantsOfType('dotted_name')[0]
    if (dottedName) edges.push({ fromQualifiedName: FILE_OWNER, toQualifiedName: null, toExternal: dottedName.text, edgeType: 'import' })
    return
  }
  if (node.type === 'class_definition') {
    const name = node.childForFieldName('name')?.text ?? '<anon>'
    symbols.push({ kind: 'class', name, qualifiedName: name, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
    const body = node.childForFieldName('body')
    if (body) for (const c of body.namedChildren) walk(c, name, symbols, edges)
    return
  }
  if (node.type === 'function_definition') {
    const name = node.childForFieldName('name')?.text ?? '<anon>'
    const qn = owner ? `${owner}.${name}` : name
    const kind = owner ? 'method' : 'function'
    symbols.push({ kind, name, qualifiedName: qn, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
    const body = node.childForFieldName('body')
    if (body) for (const c of body.namedChildren) walk(c, qn, symbols, edges)
    return
  }
  if (node.type === 'call') {
    const callee = node.childForFieldName('function')
    const name = extractCalleeName(callee)
    if (name && owner) edges.push({ fromQualifiedName: owner, toQualifiedName: null, toExternal: name, edgeType: 'call' })
    for (const c of node.namedChildren) walk(c, owner, symbols, edges)
    return
  }
  for (const c of node.namedChildren) walk(c, owner, symbols, edges)
}

function extractCalleeName(c: SyntaxNode | null): string | null {
  if (!c) return null
  if (c.type === 'identifier') return c.text
  if (c.type === 'attribute') return c.childForFieldName('attribute')?.text ?? null
  return null
}
