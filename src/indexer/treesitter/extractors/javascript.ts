import { SyntaxNode } from 'tree-sitter'
import { getParser } from '../parsers.js'
import { Extractor, ExtractionResult, ExtractedSymbol, ExtractedEdge } from '../base.js'

const FILE_OWNER = '<file>'

export class JavaScriptExtractor implements Extractor {
  extract(source: string): ExtractionResult {
    const parser = getParser('javascript')!
    const tree = parser.parse(source)
    const root = tree.rootNode

    if (root.hasError) {
      return { language: 'javascript', loc: countLoc(source), symbols: [], edges: [], parseError: 'tree-sitter reported syntax errors' }
    }

    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    walk(root, null, symbols, edges)
    return { language: 'javascript', loc: countLoc(source), symbols, edges, parseError: null }
  }
}

function countLoc(s: string): number { return s.split('\n').filter((l) => l.trim().length > 0).length }

function walk(node: SyntaxNode, owner: string | null, symbols: ExtractedSymbol[], edges: ExtractedEdge[]): void {
  if (node.type === 'call_expression') {
    const callee = node.childForFieldName('function')
    // require('x') → import edge (CommonJS)
    if (callee?.type === 'identifier' && callee.text === 'require') {
      const arg = node.childForFieldName('arguments')?.namedChildren[0]
      if (arg && arg.type === 'string') {
        edges.push({ fromQualifiedName: FILE_OWNER, toQualifiedName: null, toExternal: arg.text.slice(1, -1), edgeType: 'import' })
      }
      return
    }
    const name = extractCalleeName(callee)
    // Top-level calls (file scope) fall back to FILE_OWNER so callbacks
    // still generate fan-in for the target symbol.
    const from = owner ?? FILE_OWNER
    if (name) edges.push({ fromQualifiedName: from, toQualifiedName: null, toExternal: name, edgeType: 'call' })
    // Reference edges for callback-passed identifiers (e.g. server.tool('foo', schema, fooHandler)).
    // Captures fan-in that would otherwise be lost.
    const argsNode = node.childForFieldName('arguments')
    if (argsNode) {
      for (const arg of argsNode.namedChildren) {
        const ref = extractCalleeName(arg)
        if (ref && ref !== name) {
          edges.push({ fromQualifiedName: from, toQualifiedName: null, toExternal: ref, edgeType: 'reference' })
        }
      }
    }
    for (const c of node.namedChildren) walk(c, owner, symbols, edges)
    return
  }
  if (node.type === 'import_statement') {
    const src = node.descendantsOfType('string').find((s) => s.parent?.type === 'import_statement')
    if (src) edges.push({ fromQualifiedName: FILE_OWNER, toQualifiedName: null, toExternal: src.text.slice(1, -1), edgeType: 'import' })
    return
  }
  if (node.type === 'class_declaration') {
    const name = node.childForFieldName('name')?.text ?? '<anon>'
    symbols.push({ kind: 'class', name, qualifiedName: name, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
    const body = node.childForFieldName('body')
    if (body) for (const c of body.namedChildren) walk(c, name, symbols, edges)
    return
  }
  if (node.type === 'method_definition') {
    const name = node.childForFieldName('name')?.text ?? '<anon>'
    const qn = owner ? `${owner}.${name}` : name
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
  for (const c of node.namedChildren) walk(c, owner, symbols, edges)
}

function extractCalleeName(callee: SyntaxNode | null): string | null {
  if (!callee) return null
  if (callee.type === 'identifier') return callee.text
  if (callee.type === 'member_expression') return callee.childForFieldName('property')?.text ?? null
  return null
}
