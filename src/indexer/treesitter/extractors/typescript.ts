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
      if (calleeName && currentOwner) {
        edges.push({
          fromQualifiedName: currentOwner,
          toQualifiedName: null,
          toExternal: calleeName,
          edgeType: 'call'
        })
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
