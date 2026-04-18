import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

vi.mock('../../tools/code-index/api-client.js', () => ({
  apiGet: vi.fn().mockResolvedValue({
    symbols: [
      { id: 's1', kind: 'function', name: 'pay', qualifiedName: 'PaymentService.pay',
        filePath: 'src/payment.ts', fanIn: 3, fanOut: 1, isGodNode: false, semanticRole: 'service' }
    ]
  })
}))

const { QuerySymbolsSchema, querySymbolsHandler } = await import('../../tools/code-query/query-symbols.js')

describe('QuerySymbolsSchema', () => {
  it('rejects missing snapshot_id', () => {
    expect(() => QuerySymbolsSchema.parse({ q: 'pay' })).toThrow()
  })
  it('rejects missing q', () => {
    expect(() => QuerySymbolsSchema.parse({ snapshot_id: 's1' })).toThrow()
  })
  it('accepts valid input', () => {
    const r = QuerySymbolsSchema.parse({ snapshot_id: 'snap-1', q: 'pay' })
    expect(r.limit).toBe(50) // default
  })
})

describe('querySymbolsHandler', () => {
  it('returns formatted text content', async () => {
    const result = await querySymbolsHandler({ snapshot_id: 'snap-1', q: 'pay' })
    expect(result.content[0].type).toBe('text')
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.symbols).toHaveLength(1)
    expect(parsed.symbols[0].name).toBe('pay')
  })
})
