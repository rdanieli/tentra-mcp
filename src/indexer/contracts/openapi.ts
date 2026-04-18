import { parse as parseOpenAPIDoc } from '@readme/openapi-parser'

export interface ContractEndpoint {
  operationId: string
  method: string
  path: string
  summary?: string
}

export interface ParsedContract {
  kind: 'http' | 'grpc' | 'event' | 'graphql'
  name: string
  version: string
  endpoints: ContractEndpoint[]
  schemaSnapshot: {
    title: string
    version: string
    pathCount: number
    operationCount: number
  }
  rawSchema: unknown
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const

/**
 * Parse an OpenAPI 3.x YAML or JSON string into a normalized ParsedContract.
 * Uses @readme/openapi-parser for spec-compliant validation and dereferencing.
 * Throws on invalid input — callers should catch and surface to agent.
 */
export async function parseOpenAPI(yamlOrJson: string): Promise<ParsedContract> {
  // Parse raw YAML/JSON first; SwaggerParser.validate accepts a raw object
  let raw: unknown
  try {
    const YAML = await import('yaml')
    raw = YAML.parse(yamlOrJson)
  } catch {
    throw new Error(`OpenAPI parse error: input is not valid YAML or JSON`)
  }

  // Parse and dereference — this throws a detailed error for invalid specs
  const api = await parseOpenAPIDoc(raw as Parameters<typeof parseOpenAPIDoc>[0])

  const info = (api as Record<string, unknown>).info as Record<string, string>
  const paths = ((api as Record<string, unknown>).paths ?? {}) as Record<string, Record<string, unknown>>

  const endpoints: ContractEndpoint[] = []

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as Record<string, string> | undefined
      if (!operation) continue
      endpoints.push({
        operationId: operation.operationId ?? `${method.toUpperCase()} ${pathStr}`,
        method: method.toUpperCase(),
        path: pathStr,
        summary: operation.summary
      })
    }
  }

  return {
    kind: 'http',
    name: info.title,
    version: info.version,
    endpoints,
    schemaSnapshot: {
      title: info.title,
      version: info.version,
      pathCount: Object.keys(paths).length,
      operationCount: endpoints.length
    },
    rawSchema: api
  }
}
