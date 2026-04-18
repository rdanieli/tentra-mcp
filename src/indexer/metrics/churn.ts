// Parses git log output with file paths listed after each commit header.
// Produces a map of relativePath -> commit count.
//
// Expected input is `git log --name-only --format='commit %H%nDate:   %ad' --since=30.days`
// but the parser is forgiving: any commit header followed by indented or bare paths works.

export function parseChurn(raw: string): Map<string, number> {
  const out = new Map<string, number>()
  const lines = raw.split('\n')
  let inCommit = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('commit ')) { inCommit = true; continue }
    if (trimmed.startsWith('Date:')) continue
    if (!inCommit) continue
    if (!trimmed) continue
    out.set(trimmed, (out.get(trimmed) ?? 0) + 1)
  }
  return out
}
