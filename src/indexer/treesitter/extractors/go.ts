import { SyntaxNode } from 'tree-sitter'
import { getParser } from '../parsers.js'
import { Extractor, ExtractionResult, ExtractedSymbol, ExtractedEdge } from '../base.js'

const FILE_OWNER = '<file>'

export class GoExtractor implements Extractor {
  extract(source: string): ExtractionResult {
    const parser = getParser('go')!
    const tree = parser.parse(source)
    const root = tree.rootNode
    if (root.hasError) {
      return { language: 'go', loc: countLoc(source), symbols: [], edges: [], parseError: 'tree-sitter reported syntax errors' }
    }
    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    walk(root, null, symbols, edges)
    return { language: 'go', loc: countLoc(source), symbols, edges, parseError: null }
  }
}

function countLoc(s: string): number { return s.split('\n').filter((l) => l.trim().length > 0).length }

function walk(node: SyntaxNode, owner: string | null, symbols: ExtractedSymbol[], edges: ExtractedEdge[]): void {
  if (node.type === 'import_spec') {
    const pathNode = node.childForFieldName('path') ?? node.descendantsOfType('interpreted_string_literal')[0]
    if (pathNode) edges.push({ fromQualifiedName: FILE_OWNER, toQualifiedName: null, toExternal: pathNode.text.slice(1, -1), edgeType: 'import' })
    return
  }
  if (node.type === 'type_declaration') {
    for (const spec of node.namedChildren) {
      if (spec.type === 'type_spec') {
        const name = spec.childForFieldName('name')?.text ?? '<anon>'
        const typeField = spec.childForFieldName('type')
        if (typeField?.type === 'struct_type' || typeField?.type === 'interface_type') {
          symbols.push({ kind: 'class', name, qualifiedName: name, startLine: spec.startPosition.row + 1, endLine: spec.endPosition.row + 1 })
        }
      }
    }
    return
  }
  if (node.type === 'method_declaration') {
    const name = node.childForFieldName('name')?.text ?? '<anon>'
    const receiver = node.childForFieldName('receiver')?.descendantsOfType('type_identifier')[0]?.text ?? ''
    const qn = receiver ? `${receiver}.${name}` : name
    symbols.push({ kind: 'method', name, qualifiedName: qn, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
    const body = node.childForFieldName('body')
    if (body) for (const c of body.namedChildren) walk(c, qn, symbols, edges)
    return
  }
  if (node.type === 'function_declaration') {
    const name = node.childForFieldName('name')?.text ?? '<anon>'
    symbols.push({ kind: 'function', name, qualifiedName: name, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
    const body = node.childForFieldName('body')
    if (body) for (const c of body.namedChildren) walk(c, name, symbols, edges)
    return
  }
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function')
    let name: string | null = null
    if (fn?.type === 'identifier') name = fn.text
    else if (fn?.type === 'selector_expression') name = fn.childForFieldName('field')?.text ?? null
    if (name && owner) edges.push({ fromQualifiedName: owner, toQualifiedName: null, toExternal: name, edgeType: 'call' })
    for (const c of node.namedChildren) walk(c, owner, symbols, edges)
    return
  }
  for (const c of node.namedChildren) walk(c, owner, symbols, edges)
}
