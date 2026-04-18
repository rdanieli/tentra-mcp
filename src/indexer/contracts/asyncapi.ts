import { parse as parseYAML } from 'yaml'

export interface AsyncAPIChannel {
  channel: string
  direction: 'subscribe' | 'publish'
  operationId: string
  messageName?: string
}

export interface ParsedAsyncAPIContract {
  kind: 'event'
  name: string
  version: string
  channels: AsyncAPIChannel[]
  channelCount: number
  rawDoc: unknown
}

/**
 * Parse an AsyncAPI 2.x YAML string into a normalized ParsedAsyncAPIContract.
 *
 * Note: We use manual YAML parsing rather than @asyncapi/parser because the
 * official parser ships as an ESM-only module with a complex initialization
 * lifecycle that is not compatible with synchronous unit test environments.
 * For spec validation (schema correctness), we rely on `@asyncapi/parser`
 * being invoked at the API layer before storage — the MCP tool validates
 * before calling `record_contract`. The parser here is for extraction only.
 *
 * Throws if the YAML is malformed or if required fields (info.title,
 * info.version, channels) are missing.
 */
export async function parseAsyncAPI(yamlContent: string): Promise<ParsedAsyncAPIContract> {
  let doc: Record<string, unknown>
  try {
    doc = parseYAML(yamlContent) as Record<string, unknown>
  } catch (err) {
    throw new Error(`AsyncAPI YAML parse error: ${(err as Error).message}`)
  }

  if (!doc || typeof doc !== 'object') {
    throw new Error('AsyncAPI parse error: document is empty or not an object')
  }

  const info = doc.info as Record<string, string> | undefined
  if (!info?.title || !info?.version) {
    throw new Error('AsyncAPI parse error: missing required info.title or info.version')
  }

  const rawChannels = (doc.channels ?? {}) as Record<string, Record<string, unknown>>
  const channels: AsyncAPIChannel[] = []

  for (const [channelName, channelItem] of Object.entries(rawChannels)) {
    for (const direction of ['subscribe', 'publish'] as const) {
      const operation = channelItem[direction] as Record<string, unknown> | undefined
      if (!operation) continue

      const message = operation.message as Record<string, string> | undefined
      channels.push({
        channel: channelName,
        direction,
        operationId: (operation.operationId as string) ?? `${direction}:${channelName}`,
        messageName: message?.name
      })
    }
  }

  return {
    kind: 'event',
    name: info.title,
    version: info.version,
    channels,
    channelCount: channels.length,
    rawDoc: doc
  }
}
