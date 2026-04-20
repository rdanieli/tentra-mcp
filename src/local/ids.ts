/**
 * ID generator for local-mode rows.
 *
 * We don't need real CUIDs for local SQLite — rows only ever move between the
 * local DB and the same-process handlers. A collision-resistant URL-safe string
 * using Node's crypto.randomBytes is sufficient and has zero extra deps.
 */

import { randomBytes } from 'crypto'

export function newId(): string {
  // 12 bytes → 16 base64url chars (no padding). Prefixed so it's visually
  // distinct from hosted CUIDs while still valid for schema TEXT IDs.
  return 'loc_' + randomBytes(12).toString('base64url')
}
