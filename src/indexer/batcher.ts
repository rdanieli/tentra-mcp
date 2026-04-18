export interface BatchResult<T> {
  items: T[]
  nextCursor: number
  done: boolean
}

export function makeBatches<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('batch size must be > 0')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function nextBatch<T>(items: T[], size: number, cursor: number): BatchResult<T> {
  if (cursor >= items.length) return { items: [], nextCursor: cursor, done: true }
  const end = Math.min(cursor + size, items.length)
  const slice = items.slice(cursor, end)
  return { items: slice, nextCursor: end, done: slice.length < size }
}
