import Parser, { SyntaxNode } from 'tree-sitter'
import { getParser } from '../parsers.js'
import { Extractor, ExtractionResult, ExtractedSymbol, ExtractedEdge } from '../base.js'

const FILE_OWNER = '<file>'

export class TypeScriptExtractor implements Extractor {
  extract(source: string): ExtractionResult {
    const parser = getParser('typescript')!
    const tree = parser.parse(source)
    const root = tree.rootNode

    if (root.hasError) {
      return {
        language: 'typescript',
        loc: countLoc(source),
        symbols: [],
        edges: [],
        parseError: 'tree-sitter reported syntax errors'
      }
    }

    const symbols: ExtractedSymbol[] = []
    const edges: ExtractedEdge[] = []
    walk(root, null, symbols, edges)

    return {
      language: 'typescript',
      loc: countLoc(source),
      symbols,
      edges,
      parseError: null
    }
  }
}

function countLoc(source: string): number {
  return source.split('\n').filter((l) => l.trim().length > 0).length
}

function walk(
  node: SyntaxNode,
  currentOwner: string | null,
  symbols: ExtractedSymbol[],
  edges: ExtractedEdge[]
): void {
  switch (node.type) {
    case 'import_statement': {
      const src = node.descendantsOfType('string').find((s) => s.parent?.type === 'import_statement')
      const target = src ? src.text.slice(1, -1) : null
      if (target) {
        edges.push({
          fromQualifiedName: FILE_OWNER,
          toQualifiedName: null,
          toExternal: target,
          edgeType: 'import'
        })
      }
      return
    }
    case 'class_declaration': {
      const name = node.childForFieldName('name')?.text ?? '<anon>'
      symbols.push({
        kind: 'class',
        name,
        qualifiedName: name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      })
      const body = node.childForFieldName('body')
      if (body) {
        for (const child of body.namedChildren) {
          walk(child, name, symbols, edges)
        }
      }
      return
    }
    case 'method_definition': {
      const name = node.childForFieldName('name')?.text ?? '<anon>'
      const qn = currentOwner ? `${currentOwner}.${name}` : name
      symbols.push({
        kind: 'method',
        name,
        qualifiedName: qn,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      })
      const body = node.childForFieldName('body')
      if (body) {
        for (const child of body.namedChildren) {
          walk(child, qn, symbols, edges)
        }
      }
      return
    }
    case 'function_declaration': {
      const name = node.childForFieldName('name')?.text ?? '<anon>'
      symbols.push({
        kind: 'function',
        name,
        qualifiedName: name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      })
      const body = node.childForFieldName('body')
      if (body) {
        for (const child of body.namedChildren) {
          walk(child, name, symbols, edges)
        }
      }
      return
    }
    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text ?? '<anon>'
      symbols.push({
        kind: 'interface',
        name,
        qualifiedName: name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      })
      return
    }
    case 'call_expression': {
      const callee = node.childForFieldName('function')
      const calleeName = extractCalleeName(callee)
      // Emit call + reference edges from whichever owner is in scope.
      // Top-level calls (e.g. server.tool('foo', ..., fooHandler) at file
      // scope) fall back to FILE_OWNER so the target still gets fan-in.
      const owner = currentOwner ?? FILE_OWNER
      if (calleeName) {
        edges.push({
          fromQualifiedName: owner,
          toQualifiedName: null,
          toExternal: calleeName,
          edgeType: 'call'
        })
      }
      // Reference edges: any argument that is a bare identifier or member
      // expression refers to a symbol by name. Captures callback-passing
      // patterns like server.tool('foo', schema, fooHandler) where fooHandler
      // would otherwise show fan-in 0 because nothing calls it directly.
      const argsNode = node.childForFieldName('arguments')
      if (argsNode) {
        for (const arg of argsNode.namedChildren) {
          const refName = extractCalleeName(arg)
          if (refName && refName !== calleeName) {
            edges.push({
              fromQualifiedName: owner,
              toQualifiedName: null,
              toExternal: refName,
              edgeType: 'reference'
            })
          }
        }
      }
      for (const child of node.namedChildren) {
        walk(child, currentOwner, symbols, edges)
      }
      return
    }
    default:
      for (const child of node.namedChildren) {
        walk(child, currentOwner, symbols, edges)
      }
  }
}

function extractCalleeName(callee: SyntaxNode | null): string | null {
  if (!callee) return null
  if (callee.type === 'identifier') return callee.text
  if (callee.type === 'member_expression') return callee.childForFieldName('property')?.text ?? null
  return null
}
