import { SyntaxNode } from 'tree-sitter'
import { getParser } from '../parsers.js'
import { Extractor, ExtractionResult, ExtractedSymbol, ExtractedEdge } from '../base.js'

const FILE_OWNER = '<file>'

export class RustExtractor implements Extractor {
  extract(source: string): ExtractionResult {
    const parser = getParser('rust')!
    const tree = parser.parse(source)
    const root = tree.rootNode
    if (root.hasError) {
      return { language: 'rust', loc: countLoc(source), symbols: [], edges: [], parseError: 'tree-sitter reported syntax errors' }
    }
    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    walk(root, null, symbols, edges)
    return { language: 'rust', loc: countLoc(source), symbols, edges, parseError: null }
  }
}

function countLoc(s: string): number { return s.split('\n').filter((l) => l.trim().length > 0).length }

function flattenPath(n: SyntaxNode): string {
  // Flatten scoped_identifier / scoped_use_list into "a::b::c"
  const parts: string[] = []
  const collect = (x: SyntaxNode) => {
    for (const c of x.namedChildren) {
      if (c.type === 'identifier' || c.type === 'crate' || c.type === 'super' || c.type === 'self') parts.push(c.text)
      else collect(c)
    }
  }
  if (n.type === 'scoped_identifier' || n.type === 'scoped_use_list' || n.type === 'use_as_clause') {
    collect(n)
    return parts.join('::')
  }
  return n.text
}

function walk(n: SyntaxNode, owner: string | null, symbols: ExtractedSymbol[], edges: ExtractedEdge[]): void {
  if (n.type === 'use_declaration') {
    const arg = n.namedChildren.find((c) => c.type !== 'visibility_modifier')
    if (arg) edges.push({ fromQualifiedName: FILE_OWNER, toQualifiedName: null, toExternal: flattenPath(arg), edgeType: 'import' })
    return
  }
  if (n.type === 'struct_item' || n.type === 'enum_item' || n.type === 'trait_item') {
    const name = n.childForFieldName('name')?.text ?? '<anon>'
    symbols.push({ kind: 'class', name, qualifiedName: name, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 })
    return
  }
  if (n.type === 'impl_item') {
    const typeNode = n.childForFieldName('type')
    const ownerName = typeNode?.text ?? '<anon>'
    const body = n.childForFieldName('body')
    if (body) for (const c of body.namedChildren) walk(c, ownerName, symbols, edges)
    return
  }
  if (n.type === 'function_item') {
    const name = n.childForFieldName('name')?.text ?? '<anon>'
    const qn = owner ? `${owner}.${name}` : name
    const kind = owner ? 'method' : 'function'
    symbols.push({ kind, name, qualifiedName: qn, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 })
    const body = n.childForFieldName('body')
    if (body) for (const c of body.namedChildren) walk(c, qn, symbols, edges)
    return
  }
  if (n.type === 'call_expression') {
    const fn = n.childForFieldName('function')
    let name: string | null = null
    if (fn?.type === 'identifier') name = fn.text
    else if (fn?.type === 'field_expression') name = fn.childForFieldName('field')?.text ?? null
    else if (fn?.type === 'scoped_identifier') name = fn.namedChildren[fn.namedChildren.length - 1]?.text ?? null
    if (name && owner) edges.push({ fromQualifiedName: owner, toQualifiedName: null, toExternal: name, edgeType: 'call' })
    for (const c of n.namedChildren) walk(c, owner, symbols, edges)
    return
  }
  for (const c of n.namedChildren) walk(c, owner, symbols, edges)
}
