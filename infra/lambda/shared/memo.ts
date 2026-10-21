/**
 * Memo handling (P2). Memos are free text, stored exactly as sent: never
 * trimmed, cleaned or escaped here. Defending against what a memo says is the
 * architecture's job, not the database's. The only rule is well-formedness:
 * a string of at most MEMO_MAX_LENGTH characters. A longer one is refused,
 * never truncated, so a cut payload can't fail silently.
 */

export const MEMO_MAX_LENGTH = 280;

export type MemoResult = { ok: true; memo: string | undefined } | { ok: false; message: string };

/** Characters are counted as code points, so an emoji counts once. */
export function parseMemo(raw: unknown, field = 'memo'): MemoResult {
  if (raw === undefined || raw === null) return { ok: true, memo: undefined };
  if (typeof raw !== 'string') return { ok: false, message: `${field} must be a string` };
  if ([...raw].length > MEMO_MAX_LENGTH) {
    return { ok: false, message: `${field} must be at most ${MEMO_MAX_LENGTH} characters` };
  }
  return { ok: true, memo: raw };
}
