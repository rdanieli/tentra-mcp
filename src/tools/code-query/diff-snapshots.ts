import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const DiffSnapshotsSchema = z.object({
  from_snapshot_id: z.string().min(1).describe('The OLDER snapshot_id (the baseline to diff FROM). Obtain from list_snapshots. The diff reports what is present in `to` but missing in `from` as "added", and vice versa as "removed".'),
  to_snapshot_id: z.string().min(1).describe('The NEWER snapshot_id (the target to diff TO). Obtain from list_snapshots. Should be from the same repo as from_snapshot_id for a meaningful diff (cross-repo diffs return mostly "removed everything / added everything").')
})

export async function diffSnapshotsHandler(raw: unknown) {
  const args = DiffSnapshotsSchema.parse(raw)
  const params = new URLSearchParams({
    from_id: args.from_snapshot_id,
    to_id: args.to_snapshot_id
  })
  const data = await apiGet(`/code-graph/query/diff?${params}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
