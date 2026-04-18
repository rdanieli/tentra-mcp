import { describe, it, expect, vi } from 'vitest'

vi.mock('../../tools/code-index/api-client.js', () => ({
  apiGet: vi.fn().mockResolvedValue({
    snapshotId: 'snap-1',
    hotspots: [
      { fileId: 'f1', filePath: 'src/payment.ts', language: 'typescript',
        cyclomaticComplexity: 24, churn30d: 18, testCoverage: 20, score: 432.0 }
    ]
  })
}))

const { GetQualityHotspotsSchema, getQualityHotspotsHandler } = await import('../../tools/code-query/get-quality-hotspots.js')

describe('getQualityHotspotsHandler', () => {
  it('returns hotspot list with scores', async () => {
    const result = await getQualityHotspotsHandler({ snapshot_id: 'snap-1' })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.hotspots[0].score).toBe(432.0)
  })
})
