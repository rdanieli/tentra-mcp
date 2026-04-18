import protobuf from 'protobufjs'

export interface ProtoMethod {
  name: string
  requestType: string
  responseType: string
}

export interface ParsedProtoContract {
  kind: 'grpc'
  name: string       // first service name found
  version: string    // package name (e.g. "payments.v1")
  methods: ProtoMethod[]
  messageCount: number
  packageName: string
  rawRoot: unknown
}

/**
 * Parse a proto3 file string into a normalized ParsedProtoContract.
 * Uses protobufjs for parsing (supports proto2 + proto3).
 * Extracts the first service and all its rpc methods.
 * Throws on parse errors — callers should catch and surface to agent.
 */
export function parseProto(content: string): ParsedProtoContract {
  let root: protobuf.Root
  let packageName = ''
  try {
    const parsed = protobuf.parse(content, { keepCase: true })
    root = parsed.root
    packageName = (parsed as unknown as Record<string, unknown>).package as string ?? ''
  } catch (err) {
    throw new Error(`Proto parse error: ${(err as Error).message}`)
  }

  // Find the first service in the namespace tree
  let serviceName = 'UnknownService'
  let methods: ProtoMethod[] = []
  let messageCount = 0

  // Walk the root to find services and messages
  function walk(ns: protobuf.NamespaceBase): void {
    for (const [name, nested] of Object.entries(ns.nested ?? {})) {
      if (nested instanceof protobuf.Service && methods.length === 0) {
        serviceName = name
        for (const [methodName, method] of Object.entries(nested.methods)) {
          methods.push({
            name: methodName,
            requestType: method.requestType,
            responseType: method.responseType
          })
        }
      } else if (nested instanceof protobuf.Type) {
        messageCount += 1
      } else if (nested instanceof protobuf.Namespace) {
        walk(nested)
      }
    }
  }

  walk(root)

  return {
    kind: 'grpc',
    name: serviceName,
    version: packageName || serviceName,
    methods,
    messageCount,
    packageName,
    rawRoot: root.toJSON()
  }
}
