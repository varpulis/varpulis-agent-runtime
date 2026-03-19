/**
 * Simple FNV-1a hash for deterministic parameter hashing.
 * Used to compute `params_hash` for tool call deduplication.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // Return as unsigned 32-bit integer.
  return hash >>> 0;
}

/**
 * Compute a deterministic hash of an object by JSON-serializing
 * with sorted keys.
 */
export function hashParams(params: Record<string, unknown>): number {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  return fnv1a(sorted);
}
