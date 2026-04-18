import { describe, it, expect, vi } from 'vitest'

vi.mock('../../tools/code-index/api-client.js', () => ({
  apiGet: vi.fn().mockResolvedValue({
    fromSnapshotId: 'sn1', toSnapshotId: 'sn2',
    files: { added: ['src/new.ts'], removed: [], modified: ['src/payment.ts'] },
    symbols: { added: ['NewService.init'], removed: [] },
    godNodes: { appeared: [], resolved: ['OldRouter'] }
  })
}))

const { DiffSnapshotsSchema, diffSnapshotsHandler } = await import('../../tools/code-query/diff-snapshots.js')

describe('DiffSnapshotsSchema', () => {
  it('requires from_snapshot_id and to_snapshot_id', () => {
    expect(() => DiffSnapshotsSchema.parse({ from_snapshot_id: 'a' })).toThrow()
  })
})

describe('diffSnapshotsHandler', () => {
  it('returns file + symbol + god-node diff', async () => {
    const result = await diffSnapshotsHandler({ from_snapshot_id: 'sn1', to_snapshot_id: 'sn2' })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.files.added).toContain('src/new.ts')
    expect(parsed.godNodes.resolved).toContain('OldRouter')
  })
})
