// X12 835 (ERA) denial parser + CARC guidance + specialty-aware appeal drafting.

export const CARC_MAP: Record<string, { category: string; action: string }> = {
  "4":   { category: "Service inconsistent with diagnosis/age/sex", action: "Review patient demographics and diagnosis codes against the billed CPT; correct or add supporting ICD-10 codes." },
  "11":  { category: "Diagnosis inconsistent with procedure", action: "Verify ICD-10 matches CPT medical necessity criteria; update diagnosis or add clinical notes." },
  "15":  { category: "Prior authorization number invalid", action: "Confirm the authorization number with the payer; re-obtain if expired or miskeyed, then resubmit." },
  "16":  { category: "Coding / missing info", action: "Add the missing modifier or documentation and resubmit a corrected claim." },
  "18":  { category: "Duplicate claim", action: "Verify original ICN status; void the duplicate, or appeal if a distinct encounter (modifier 59/XE/XP/XS/XU)." },
  "22":  { category: "Coordination of benefits", action: "Verify primary/secondary payer order; resubmit as secondary with the primary EOB attached." },
  "29":  { category: "Timely filing", action: "Pull the clearinghouse 277CA acceptance timestamp and submit a proof-of-timely-filing appeal." },
  "49":  { category: "Service excluded from plan", action: "Verify benefits; bill patient or secondary payer if applicable." },
  "50":  { category: "Medical necessity", action: "Gather ICD-10 support and LCD/NCD guidelines; write a clinical appeal letter with supporting documentation." },
  "57":  { category: "Prior authorization not obtained before service", action: "Check the retro-auth window (often 14–30 days); attach authorization number if obtained after service." },
  "96":  { category: "Non-covered charge", action: "Verify the benefit plan/fee schedule; bill the patient only if a valid ABN is on file." },
  "97":  { category: "Bundling / NCCI edit", action: "Check NCCI edits; append modifier 59 or X{EPSU} if a separate site/session, otherwise write off per contract." },
  "109": { category: "Not covered by this payer/contractor", action: "Confirm correct payer on claim; verify provider enrollment and covered services list." },
  "119": { category: "Benefit maximum reached", action: "Verify benefit accumulation; bill secondary payer or patient per plan limits." },
  "125": { category: "Submission/billing error", action: "Review claim form for data entry errors (NPI, DOS, revenue codes, type of bill); submit a corrected claim (TOB ending in 7) rather than an appeal." },
  "136": { category: "Failure to follow prior payer guidelines", action: "Attach primary payer EOB and resubmit per coordination of benefits rules." },
  "151": { category: "Excess units billed", action: "Review documentation for each unit billed; resubmit with supporting records if units are correct." },
  "167": { category: "Diagnosis not covered", action: "Review diagnosis coding; add supporting diagnoses or appeal with clinical documentation." },
  "170": { category: "Rendering provider type not covered", action: "Verify provider enrollment and credentialing; correct billing NPI or provider type." },
  "183": { category: "No medical record certification on file", action: "Submit requested medical records or certification immediately per payer's documentation request." },
  "185": { category: "Rendering provider not eligible for this service", action: "Verify provider credentials and specialty enrollment; re-credential if needed." },
  "197": { category: "Prior auth missing", action: "Check the retro-auth window (often 14–30 days) or attach the approved authorization number." },
  "198": { category: "Prior auth exceeded", action: "Request auth extension or submit retro-auth; attach clinical notes supporting medical necessity." },
  "234": { category: "Procedure not separately payable", action: "Review CMS bundling rules; apply appropriate modifier or write off per contract." },
  "236": { category: "NCCI procedure incompatibility", action: "Review NCCI edits for this date of service; apply modifier 59/X{EPSU} only if clinically distinct." },
  "243": { category: "Service not authorized by plan", action: "Submit authorization retroactively if allowed; attach clinical documentation for medical necessity." },
  "B9":  { category: "Discharge against medical advice (AMA)", action: "Document that discharge was clinically appropriate or patient was counseled; appeal with physician notes." },
  "B15": { category: "Special handling required", action: "Review payer-specific billing requirements and resubmit with correct handling code." },
  "MA01": { category: "More information required from provider", action: "Attach the requested documentation and resubmit within the payer's response window." },
  "MA04": { category: "Incomplete or invalid prior authorization", action: "Obtain or correct the authorization number and resubmit." },
  "N479": { category: "Missing or incomplete authorization number", action: "Add the payer authorization number to field 23 (UB-04 box 63) and resubmit." },
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

function appealSpecialtyNote(carc: string, specialty?: string): string {
  if (!specialty || specialty === "other") return "";
  const notes: Record<string, Record<string, string>> = {
    primary_care: {
      "50": "Per CMS E&M documentation guidelines (2021 revisions), medical necessity is established by complexity of MDM or total time. Attached: encounter note, complete problem list, and MDM documentation supporting this service level.",
      "97": "Modifier 25 supports a separately identifiable E&M on the same day as a procedure. The attached note documents a significant, separately identifiable evaluation that is distinct from the pre/post-procedure work.",
      "29": "Proof of timely filing: attached is the clearinghouse 277CA transaction confirming electronic submission within payer timely filing limits.",
      "119": "Patient's current-year benefit accumulation documentation is attached, confirming this service falls within the covered benefit limit for this plan year.",
      _default: "Attached are the complete encounter notes including HPI, review of systems, physical exam, and medical decision-making documentation for this primary care visit.",
    },
    pediatrics: {
      "50": "This well-child/preventive visit meets Bright Futures guidelines (AAP) for the patient's age group. EPSDT coverage requires comprehensive screening at specified intervals. Attached: screening documentation and all developmental assessment tools used at this visit.",
      "4": "Patient age and gender on the date of service are confirmed in the attached demographics. The CPT code billed is appropriate for this patient's age bracket per AAP/Bright Futures age-band guidelines.",
      "97": "Vaccine administration (CPT 90460/90461) is separately billable when performed with counseling on the same date as a preventive E&M per CPT guidelines. Attached is documentation of face-to-face counseling provided for each vaccine administered.",
      "243": "These vaccines are covered without prior authorization under EPSDT for Medicaid patients, and under preventive benefits for commercial plans per the ACA preventive care mandate. Attached: Vaccine Information Statements (VIS) and clinical indication documentation.",
      "151": "Each unit of vaccine administration is documented in the attached immunization record and clinical note. Units billed correspond to individual vaccine antigens administered with counseling.",
      _default: "Attached are the complete encounter notes, developmental screening results, immunization record, and documentation supporting this pediatric visit per AAP/Bright Futures guidelines.",
    },
    acute_care: {
      "50": "The admission meets established clinical criteria for inpatient level of care. Attached: physician H&P, admission orders, nursing assessment, lab/imaging results, and clinical indicators supporting medical necessity. The treating physician certifies that the patient's condition required inpatient care and could not safely be managed on an outpatient basis.",
      "167": "The principal and secondary diagnoses are supported by the attached H&P, lab results, imaging reports, operative notes, and discharge summary. ICD-10 coding reflects the final coded diagnosis per UHDDS guidelines.",
      "183": "Attached is the complete inpatient medical record: physician H&P, all progress notes, nursing documentation, lab and imaging results, operative/procedure notes, and discharge summary. All entries are signed and dated.",
      "125": "A corrected claim (Type of Bill ending in 7) is submitted with this appeal, correcting the billing error. The original claim ICN is referenced above.",
      "151": "Each unit of service is documented in the attached nursing flowsheets, physician orders, and therapy notes. Units billed reflect clinically documented services consistent with the patient's plan of care.",
      "57": "The payer-required authorization was obtained. The authorization number is noted above. Attached is confirmation from the payer's authorization system.",
      "197": "If a retro-authorization was obtained, it is attached. Clinical documentation demonstrating the emergency nature of the admission and the medical necessity of inpatient care is also attached.",
      _default: "Attached are the complete inpatient medical records: H&P, physician orders, all progress notes, nursing documentation, lab and imaging results, and discharge summary documenting medical necessity.",
    },
  };
  const sp = notes[specialty];
  if (!sp) return "";
  return sp[carc] ?? sp["_default"] ?? "";
}

export function draftAppeal(
  c: { claim_id: string; payer_icn?: string | null; carc: string; category?: string | null; denied_cents: number; notes?: string | null },
  practice: string,
  specialty?: string,
) {
  const info = carcInfo(c.carc);
  const specNote = appealSpecialtyNote(c.carc, specialty);
  return `FORMAL CLAIM RECONSIDERATION / APPEAL

From: ${practice}
Claim ID: ${c.claim_id}    Payer ICN: ${c.payer_icn || "(on file)"}
Denial reason: CARC ${c.carc} — ${info.category}    Amount denied: $${(c.denied_cents / 100).toFixed(2)}

To Appeals / Medical Review Department:

We request reconsideration of the denial referenced above. ${c.notes ? "Clinical/documentation summary: " + c.notes : "[Add clinical documentation summary here.]"}

Recommended handling: ${info.action}
${specNote ? "\nSpecialty-specific documentation:\n" + specNote : ""}
Supporting documentation is attached. Please reprocess this claim for payment, or provide the specific policy basis for denial and the next level of appeal.

Sincerely,
${practice}

(DRAFT — a qualified biller or clinician must review before sending.)`;
}

/** Common denial patterns by specialty, used in dashboard and MCP get_summary. */
export const SPECIALTY_DENIAL_PATTERNS: Record<string, Array<{ carc: string; common_scenario: string }>> = {
  primary_care: [
    { carc: "50", common_scenario: "E&M downcoded for medical necessity — inadequate MDM or time documentation" },
    { carc: "97", common_scenario: "Same-day E&M + procedure bundled — missing modifier 25 or inadequate separate documentation" },
    { carc: "29", common_scenario: "Timely filing — claim submitted after payer window" },
    { carc: "16", common_scenario: "Missing info — NPI, referring provider, NDC, or required modifier absent" },
    { carc: "119", common_scenario: "Annual wellness visit benefit maximum reached for plan year" },
  ],
  pediatrics: [
    { carc: "4", common_scenario: "Well-child CPT for wrong age group, or age/sex mismatch with ICD-10 diagnosis" },
    { carc: "97", common_scenario: "Vaccine administration bundled with preventive E&M — modifier or face-to-face counseling documentation needed" },
    { carc: "50", common_scenario: "EPSDT screening denied for medical necessity — missing developmental assessment documentation" },
    { carc: "243", common_scenario: "Vaccine not authorized — commercial plan prior auth misunderstanding; ACA mandate applies" },
    { carc: "151", common_scenario: "Excess vaccine administration units — each antigen must be separately documented with counseling" },
  ],
  acute_care: [
    { carc: "50", common_scenario: "Inpatient admission denied — inadequate InterQual/MCG clinical indicators in H&P and orders" },
    { carc: "167", common_scenario: "DRG downgrade — principal diagnosis not supported by documentation or ICD-10 coding" },
    { carc: "183", common_scenario: "Medical records not on file — documentation request not responded to in time" },
    { carc: "125", common_scenario: "Type of bill (TOB) or revenue code error — corrected claim (XX7) needed, not a clinical appeal" },
    { carc: "197", common_scenario: "Pre-service authorization missing — retro-auth window often 14–30 days from DOS" },
  ],
  other: [
    { carc: "16", common_scenario: "Missing or incorrect information on the claim" },
    { carc: "50", common_scenario: "Medical necessity not documented sufficiently" },
    { carc: "29", common_scenario: "Timely filing deadline missed" },
    { carc: "97", common_scenario: "Bundling/NCCI edit — modifier may be needed" },
    { carc: "197", common_scenario: "Prior authorization missing or expired" },
  ],
};
