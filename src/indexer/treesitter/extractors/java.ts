import { SyntaxNode } from 'tree-sitter'
import { getParser } from '../parsers.js'
import { Extractor, ExtractionResult, ExtractedSymbol, ExtractedEdge } from '../base.js'

const FILE_OWNER = '<file>'

export class JavaExtractor implements Extractor {
  extract(source: string): ExtractionResult {
    const parser = getParser('java')!
    const tree = parser.parse(source)
    const root = tree.rootNode
    if (root.hasError) {
      return { language: 'java', loc: countLoc(source), symbols: [], edges: [], parseError: 'tree-sitter reported syntax errors' }
    }
    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    walk(root, null, symbols, edges)
    return { language: 'java', loc: countLoc(source), symbols, edges, parseError: null }
  }
}

function countLoc(s: string): number { return s.split('\n').filter((l) => l.trim().length > 0).length }

function walk(n: SyntaxNode, owner: string | null, symbols: ExtractedSymbol[], edges: ExtractedEdge[]): void {
  if (n.type === 'import_declaration') {
    const name = n.descendantsOfType('scoped_identifier')[0] ?? n.descendantsOfType('identifier')[0]
    if (name) edges.push({ fromQualifiedName: FILE_OWNER, toQualifiedName: null, toExternal: name.text, edgeType: 'import' })
    return
  }
  if (n.type === 'class_declaration' || n.type === 'interface_declaration') {
    const name = n.childForFieldName('name')?.text ?? '<anon>'
    const kind = n.type === 'interface_declaration' ? 'interface' : 'class'
    symbols.push({ kind, name, qualifiedName: name, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 })
    const body = n.childForFieldName('body')
    if (body) for (const c of body.namedChildren) walk(c, name, symbols, edges)
    return
  }
  if (n.type === 'method_declaration') {
    const name = n.childForFieldName('name')?.text ?? '<anon>'
    const qn = owner ? `${owner}.${name}` : name
    symbols.push({ kind: 'method', name, qualifiedName: qn, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 })
    const body = n.childForFieldName('body')
    if (body) for (const c of body.namedChildren) walk(c, qn, symbols, edges)
    return
  }
  if (n.type === 'method_invocation') {
    const name = n.childForFieldName('name')?.text
    if (name && owner) edges.push({ fromQualifiedName: owner, toQualifiedName: null, toExternal: name, edgeType: 'call' })
    for (const c of n.namedChildren) walk(c, owner, symbols, edges)
    return
  }
  for (const c of n.namedChildren) walk(c, owner, symbols, edges)
}
