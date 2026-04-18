import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const DiffSnapshotsSchema = z.object({
  from_snapshot_id: z.string().min(1).describe('Older snapshot ID'),
  to_snapshot_id: z.string().min(1).describe('Newer snapshot ID')
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
