import { describe, it, expect, vi } from 'vitest'

vi.mock('../../tools/code-index/api-client.js', () => ({
  apiGet: vi.fn().mockResolvedValue({
    found: true, hopCount: 2,
    path: [
      { id: 's1', name: 'handleRequest', qualifiedName: 'Controller.handleRequest', filePath: 'src/ctrl.ts', purpose: 'Entry point' },
      { id: 's2', name: 'processPayment', qualifiedName: 'PaymentService.processPayment', filePath: 'src/payment.ts', purpose: 'Core payment' },
      { id: 's3', name: 'chargeCard', qualifiedName: 'StripeAdapter.chargeCard', filePath: 'src/stripe.ts', purpose: null }
    ],
    edges: [{ from: 's1', to: 's2', type: 'call' }, { from: 's2', to: 's3', type: 'call' }]
  })
}))

const { ExplainCodePathSchema, explainCodePathHandler } = await import('../../tools/code-query/explain-code-path.js')

describe('ExplainCodePathSchema', () => {
  it('requires from_symbol + to_symbol + snapshot_id', () => {
    expect(() => ExplainCodePathSchema.parse({ from_symbol: 'a' })).toThrow()
  })
})

describe('explainCodePathHandler', () => {
  it('returns hopCount and annotated path', async () => {
    const result = await explainCodePathHandler({
      from_symbol: 's1', to_symbol: 's3', snapshot_id: 'snap-1'
    })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.hopCount).toBe(2)
    expect(parsed.path).toHaveLength(3)
    expect(parsed.path[1].purpose).toBe('Core payment')
  })
})
