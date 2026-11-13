import type { Env } from "./lib";
import { uid } from "./lib";
import type { Denial } from "./eras";

/** Upsert denials for a practice. Returns number of rows written. */
export async function importDenials(env: Env, practiceId: string, denials: Denial[], source: string, fileId: string | null, payer?: string, notes?: string) {
  if (!denials.length) return 0;
  const stmt = env.DB.prepare(
    `INSERT INTO claims (id, practice_id, claim_id, payer_icn, payer, billed_cents, paid_cents, denied_cents, carc, category, recommended_action, notes, source, file_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(practice_id, claim_id, carc) DO UPDATE SET
       denied_cents=excluded.denied_cents, payer_icn=excluded.payer_icn, updated_at=datetime('now')`);
  const batch = denials.map((d) => stmt.bind(uid(), practiceId, d.claim_id, d.payer_icn || null, payer ?? null, d.billed_cents, d.paid_cents, d.denied_cents, d.carc, d.category, d.recommended_action, notes ?? null, source, fileId));
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
  return denials.length;
}
