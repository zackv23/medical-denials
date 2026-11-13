// X12 835 (ERA) denial parser + CARC guidance + appeal drafting.
export const CARC_MAP: Record<string, { category: string; action: string }> = {
  "16": { category: "Coding / missing info", action: "Add the missing modifier or documentation and resubmit a corrected claim." },
  "18": { category: "Duplicate claim", action: "Verify original ICN status; void the duplicate, or appeal if a distinct encounter (modifier 59/XE/XP/XS/XU)." },
  "29": { category: "Timely filing", action: "Pull the clearinghouse 277CA acceptance timestamp and submit a proof-of-timely-filing appeal." },
  "50": { category: "Medical necessity", action: "Gather ICD-10 support and LCD/NCD guidelines; write a clinical appeal letter." },
  "96": { category: "Non-covered charge", action: "Verify the benefit plan/fee schedule; bill the patient only if a valid ABN is on file." },
  "97": { category: "Bundling / inclusive", action: "Check NCCI edits; append a modifier if a separate site/session, otherwise write off per contract." },
  "197": { category: "Prior auth missing", action: "Check the retro-auth window (often 14–30 days) or attach the approved authorization number." },
};
// Expected contractual adjustments are not denials.
const CONTRACTUAL = new Set(["45", "253", "2", "3", "1"]);

export interface Denial {
  claim_id: string; payer_icn: string; billed_cents: number; paid_cents: number;
  denied_cents: number; carc: string; group: string; category: string; recommended_action: string;
}

export const cents = (s: string | undefined) => {
  const n = parseFloat(s ?? "");
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export function carcInfo(carc: string) {
  return CARC_MAP[carc] ?? { category: "Other denial", action: `Manual review required for CARC ${carc}.` };
}

export function looksLike835(text: string) {
  return /^\s*ISA[*]/.test(text) || (text.includes("CLP*") && text.includes("CAS*"));
}

export function parse835(raw: string): Denial[] {
  const text = raw.replace(/\r?\n/g, "");
  let elSep = "*", segSep = "~";
  if (text.startsWith("ISA") && text.length >= 106) { elSep = text[3]; segSep = text[105]; }
  const out: Denial[] = [];
  let claim: { id: string; icn: string; billed: number; paid: number } | null = null;
  for (const seg of text.split(segSep).map((s) => s.trim()).filter(Boolean)) {
    const el = seg.split(elSep);
    if (el[0] === "CLP") {
      claim = { id: el[1] || "UNKNOWN", billed: cents(el[3]), paid: cents(el[4]), icn: el[7] || "" };
    } else if (el[0] === "CAS" && claim) {
      const group = el[1] ?? "";
      if (!["CO", "OA", "PI"].includes(group)) continue;
      // CAS carries up to six (reason, amount, qty) triples.
      for (let i = 2; i + 1 < el.length; i += 3) {
        const carc = el[i]; const amt = cents(el[i + 1]);
        if (!carc || amt <= 0 || CONTRACTUAL.has(carc)) continue;
        const info = carcInfo(carc);
        out.push({
          claim_id: claim.id, payer_icn: claim.icn, billed_cents: claim.billed, paid_cents: claim.paid,
          denied_cents: amt, carc, group, category: info.category, recommended_action: info.action,
        });
      }
    }
  }
  return out;
}

/** Minimal CSV: header row with claim_id, carc, denied (or denied_amount), optional payer_icn, billed, paid, payer. */
export function parseCsv(text: string): Denial[] {
  const rows = text.trim().split(/\r?\n/).map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
  const head = rows.shift()?.map((h) => h.toLowerCase()) ?? [];
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const ci = col("claim_id", "claim", "claimid"), cc = col("carc", "reason_code", "code");
  const cd = col("denied", "denied_amount", "amount"), cp = col("payer_icn", "icn"), cb = col("billed", "billed_amount"), cpd = col("paid", "paid_amount");
  if (ci < 0 || cc < 0 || cd < 0) throw new Error("CSV needs columns: claim_id, carc, denied");
  return rows.filter((r) => r[ci]).map((r) => {
    const info = carcInfo(r[cc]);
    return {
      claim_id: r[ci], payer_icn: cp >= 0 ? r[cp] : "", billed_cents: cb >= 0 ? cents(r[cb]) : 0,
      paid_cents: cpd >= 0 ? cents(r[cpd]) : 0, denied_cents: cents(r[cd]), carc: r[cc], group: "CO",
      category: info.category, recommended_action: info.action,
    };
  });
}

export function draftAppeal(c: { claim_id: string; payer_icn?: string | null; carc: string; category?: string | null; denied_cents: number; notes?: string | null }, practice: string) {
  const info = carcInfo(c.carc);
  return `FORMAL CLAIM RECONSIDERATION / APPEAL

From: ${practice}
Claim ID: ${c.claim_id}    Payer ICN: ${c.payer_icn || "(on file)"}
Denial reason: CARC ${c.carc} — ${info.category}    Amount denied: $${(c.denied_cents / 100).toFixed(2)}

To Appeals / Medical Review Department:

We request reconsideration of the denial referenced above. ${c.notes ? "Clinical/documentation summary: " + c.notes : "[Add clinical documentation summary here.]"}

Recommended handling: ${info.action}

Supporting documentation is attached. Please reprocess this claim for payment, or provide the specific policy basis for denial and the next level of appeal.

Sincerely,
${practice}

(DRAFT — a qualified biller or clinician must review before sending.)`;
}
