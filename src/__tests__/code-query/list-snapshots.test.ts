import { describe, it, expect, vi } from 'vitest'

vi.mock('../../tools/code-index/api-client.js', () => ({
  apiGet: vi.fn().mockResolvedValue({
    repoId: 'repo-1',
    snapshots: [
      { id: 'sn2', commitSha: 'def456', createdAt: '2026-04-15T10:00:00Z', stats: { fileCount: 42 }, parentSnapshotId: 'sn1' },
      { id: 'sn1', commitSha: 'abc123', createdAt: '2026-04-14T09:00:00Z', stats: { fileCount: 40 }, parentSnapshotId: null }
    ]
  })
}))

const { ListSnapshotsSchema, listSnapshotsHandler } = await import('../../tools/code-query/list-snapshots.js')

describe('ListSnapshotsSchema', () => {
  it('requires repo_id', () => {
    expect(() => ListSnapshotsSchema.parse({})).toThrow()
  })
})

describe('listSnapshotsHandler', () => {
  it('returns time-ordered snapshot list', async () => {
    const result = await listSnapshotsHandler({ repo_id: 'repo-1' })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.snapshots).toHaveLength(2)
    expect(parsed.snapshots[0].commitSha).toBe('def456')
  })
})
