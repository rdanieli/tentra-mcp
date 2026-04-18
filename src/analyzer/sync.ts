// ─── Arch-Sync: Drift Detection ──────────────────────────────────────────────

export interface SyncDiff {
  addedServices: string[]
  removedServices: string[]
  addedConnections: { from: string; to: string; type: string }[]
  removedConnections: { from: string; to: string; type: string }[]
  changedServices: { id: string; field: string; saved: string; detected: string }[]
  score: number
}

interface ServiceInput {
  id: string
  type: string
  responsibility: string
}

interface ConnectionInput {
  from: string
  to: string
  type: string
}

/**
 * Fuzzy-match two service IDs.
 * Handles common abbreviations like "service" vs "svc", "database" vs "db", etc.
 */
function normalizeId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[_-]/g, '')
    .replace(/service/g, 'svc')
    .replace(/database/g, 'db')
    .replace(/gateway/g, 'gw')
    .replace(/message/g, 'msg')
    .replace(/queue/g, 'q')
    .replace(/external/g, 'ext')
}

function fuzzyMatch(a: string, b: string): boolean {
  if (a === b) return true
  return normalizeId(a) === normalizeId(b)
}

/**
 * Build a mapping from saved service IDs to detected service IDs.
 * First tries exact match, then fuzzy match.
 */
function buildServiceMapping(
  savedServices: ServiceInput[],
  detectedServices: ServiceInput[]
): Map<string, string> {
  const mapping = new Map<string, string>()
  const detectedIds = new Set(detectedServices.map(s => s.id))
  const usedDetected = new Set<string>()

  // Pass 1: exact matches
  for (const saved of savedServices) {
    if (detectedIds.has(saved.id)) {
      mapping.set(saved.id, saved.id)
      usedDetected.add(saved.id)
    }
  }

  // Pass 2: fuzzy matches for unmatched services
  for (const saved of savedServices) {
    if (mapping.has(saved.id)) continue
    for (const detected of detectedServices) {
      if (usedDetected.has(detected.id)) continue
      if (fuzzyMatch(saved.id, detected.id)) {
        mapping.set(saved.id, detected.id)
        usedDetected.add(detected.id)
        break
      }
    }
  }

  return mapping
}

function connectionKey(c: ConnectionInput): string {
  return `${c.from}->${c.to}:${c.type}`
}

export function computeDiff(
  savedServices: ServiceInput[],
  savedConnections: ConnectionInput[],
  detectedServices: ServiceInput[],
  detectedConnections: ConnectionInput[]
): SyncDiff {
  const mapping = buildServiceMapping(savedServices, detectedServices)

  const matchedSavedIds = new Set(mapping.keys())
  const matchedDetectedIds = new Set(mapping.values())

  // Services in detected but not in saved (added to code, missing from diagram)
  const addedServices = detectedServices
    .filter(s => !matchedDetectedIds.has(s.id))
    .map(s => s.id)

  // Services in saved but not in detected (in diagram, missing from code)
  const removedServices = savedServices
    .filter(s => !matchedSavedIds.has(s.id))
    .map(s => s.id)

  // Field-level changes on matched services
  const changedServices: SyncDiff['changedServices'] = []
  const savedMap = new Map(savedServices.map(s => [s.id, s]))
  const detectedMap = new Map(detectedServices.map(s => [s.id, s]))

  for (const [savedId, detectedId] of mapping) {
    const saved = savedMap.get(savedId)!
    const detected = detectedMap.get(detectedId)!

    if (saved.type !== detected.type) {
      changedServices.push({
        id: savedId,
        field: 'type',
        saved: saved.type,
        detected: detected.type
      })
    }

    if (
      saved.responsibility &&
      detected.responsibility &&
      saved.responsibility.toLowerCase() !== detected.responsibility.toLowerCase()
    ) {
      changedServices.push({
        id: savedId,
        field: 'responsibility',
        saved: saved.responsibility,
        detected: detected.responsibility
      })
    }
  }

  // Normalize connections: remap saved IDs to detected IDs for comparison
  const remapId = (id: string): string => mapping.get(id) ?? id

  const savedConnNormalized = new Set(
    savedConnections.map(c => connectionKey({ from: remapId(c.from), to: remapId(c.to), type: c.type }))
  )
  const detectedConnSet = new Set(
    detectedConnections.map(c => connectionKey(c))
  )

  const addedConnections = detectedConnections
    .filter(c => !savedConnNormalized.has(connectionKey(c)))
    .map(c => ({ from: c.from, to: c.to, type: c.type }))

  const removedConnections = savedConnections
    .filter(c => !detectedConnSet.has(connectionKey({ from: remapId(c.from), to: remapId(c.to), type: c.type })))
    .map(c => ({ from: c.from, to: c.to, type: c.type }))

  // Accuracy score: 100 - (total_changes / total_items * 100), clamped to [0, 100]
  const totalChanges =
    addedServices.length +
    removedServices.length +
    addedConnections.length +
    removedConnections.length +
    changedServices.length

  const totalItems = Math.max(
    1,
    savedServices.length +
    detectedServices.length +
    savedConnections.length +
    detectedConnections.length
  )

  const score = Math.max(0, Math.min(100, Math.round(100 - (totalChanges / totalItems) * 100)))

  return {
    addedServices,
    removedServices,
    addedConnections,
    removedConnections,
    changedServices,
    score
  }
}
