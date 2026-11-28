// Pre-submission claim check (urgent care / primary care office visits).
// Compares the billed codes with what the visit note supports, before the claim goes out:
//   1. E/M level: 2021+ office-visit rules (level = medical decision making, or total time if higher).
//   2. Missed add-ons: tests, injections, treatments and procedures documented in the note but not billed.
//   3. Modifier 25: E/M billed with a same-day procedure but without -25.
// Rules-based and explainable: every flag quotes the note text it relies on.
// Output is a suggestion for a certified coder or the clinician to confirm. It never changes a claim.
// No external calls and no storage: safe to run on de-identified or sample data.

export type Setting = "urgent_care" | "primary_care";
export type MdmLevel = "straightforward" | "low" | "moderate" | "high";

export interface Visit {
  visit_id: string;
  setting?: Setting;
  patient_type: "new" | "established";
  billed: string[]; // CPT/HCPCS codes as billed, modifiers allowed: "99213", "99214-25", "J1885"
  note: string; // the provider's visit note (free text or dictation output)
  minutes?: number; // total provider time on the date of service, if documented
}

export interface Flag {
  type: "under_coded" | "over_coded" | "missed_addon" | "missing_modifier";
  code: string;
  message: string;
  evidence: string[];
}

export interface VisitResult {
  visit_id: string;
  billed_em: string | null;
  supported_em: string | null;
  mdm: { problems: MdmLevel; data: MdmLevel; risk: MdmLevel; level: MdmLevel };
  time_supports: string | null;
  flags: Flag[];
}

const EM = {
  new: { straightforward: "99202", low: "99203", moderate: "99204", high: "99205" },
  established: { straightforward: "99212", low: "99213", moderate: "99214", high: "99215" },
} as const;
// Minimum total minutes for each level (CPT 2021+ office visit time thresholds).
const TIME = {
  new: [["99205", 60], ["99204", 45], ["99203", 30], ["99202", 15]],
  established: [["99215", 40], ["99214", 30], ["99213", 20], ["99212", 10]],
} as const;
const EM_CODES = new Set(["99202", "99203", "99204", "99205", "99211", "99212", "99213", "99214", "99215"]);
const RANK: Record<MdmLevel, number> = { straightforward: 0, low: 1, moderate: 2, high: 3 };
const LEVELS: MdmLevel[] = ["straightforward", "low", "moderate", "high"];
const emRank = (code: string) => Number(code.slice(-1)); // 99213 -> 3

// ---------- note parsing ----------
const sentences = (note: string) =>
  note.replace(/\r/g, "").split(/(?<=[.;!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

// Words that mean the thing was NOT done (a test that came back negative still counts as done).
const NOT_DONE = /\b(not (done|performed|given|obtained|ordered)|declined|deferred|refused|unable to (obtain|perform)|cancel+ed|will consider|consider(ing)?|if (worse|no improvement|symptoms persist)|return (if|for)|recommend(ed)? (follow|f\/u))\b/i;
const NEGATED_SYMPTOM = /\b(no|denies|denied|without|negative for|absent)\b/i;

function find(sents: string[], re: RegExp, { allowNotDone = false } = {}) {
  return sents.filter((s) => re.test(s) && (allowNotDone || !NOT_DONE.test(s)));
}

// ---------- MDM: problems ----------
function problemsLevel(note: string, sents: string[]) {
  const ev: string[] = [];
  const assessment = (note.match(/(assessment|impression|diagnos[ie]s|a\/p|plan)\s*[:\-]([\s\S]*)/i)?.[2] ?? "")
    .split(/\n|;|\d+[.)]\s/).map((s) => s.trim()).filter((s) => s.length > 2);
  const high = find(sents, /\b(sepsis|threat to life|acute (mi|myocardial)|stroke|pulmonary embol|severe exacerbation|respiratory distress)\b/i);
  if (high.length) return { level: "high" as MdmLevel, ev: high.slice(0, 2) };
  const systemic = find(sents, /\b(fever|febrile|chills|myalgia|body aches|tachycardi|dehydrat)/i).filter((s) => !NEGATED_SYMPTOM.test(s));
  const complicatedInjury = find(sents, /\b(fracture|dislocation|laceration repair|sprain with|tendon|neurovascular)\b/i).filter((s) => !NEGATED_SYMPTOM.test(s));
  const chronicFlare = find(sents, /\b(exacerbation|flare|uncontrolled|worsening (asthma|copd|diabetes|hypertension))\b/i);
  const chronicStable = find(sents, /\b(stable|controlled|well[- ]controlled)\b.*\b(hypertension|diabetes|asthma|copd|hypothyroid|hyperlipid)|\b(hypertension|diabetes|asthma|copd|hypothyroid|hyperlipid)\w*\b.*\b(stable|controlled)\b/i);
  const problemCount = Math.max(assessment.length, 1);
  if (systemic.length) ev.push(...systemic.slice(0, 1));
  if (complicatedInjury.length) ev.push(...complicatedInjury.slice(0, 1));
  if (chronicFlare.length) ev.push(...chronicFlare.slice(0, 1));
  if (chronicStable.length >= 2) ev.push(...chronicStable.slice(0, 2));
  if (systemic.length || complicatedInjury.length || chronicFlare.length || chronicStable.length >= 2 || problemCount >= 3)
    return { level: "moderate" as MdmLevel, ev: ev.length ? ev : [`${problemCount} problems in assessment`] };
  if (problemCount >= 2 || chronicStable.length === 1 || find(sents, /\b(acute|uncomplicated|uri|pharyngitis|otitis|sinusitis|uti|cystitis|bronchitis|conjunctivitis|sprain|strain|rash|cellulitis)\b/i).length)
    return { level: "low" as MdmLevel, ev: assessment.slice(0, 2) };
  return { level: "straightforward" as MdmLevel, ev: [] };
}

// ---------- MDM: data ----------
const TESTS: [string, RegExp][] = [
  ["strep test", /\b(rapid strep|strep (test|swab|screen)|throat culture)\b/i],
  ["flu test", /\b(rapid flu|influenza (test|swab|a\/b)|flu (test|swab))\b/i],
  ["COVID test", /\b(covid|sars-cov-2)\b.*\b(test|antigen|swab|pcr)\b|\b(test|antigen|swab|pcr)\b.*\b(covid|sars-cov-2)\b/i],
  ["urinalysis", /\b(urinalysis|ua dip|urine dip|dipstick|\bua\b)/i],
  ["glucose", /\b(fingerstick|point of care glucose|poc glucose|glucometer|accucheck|accu-chek)\b/i],
  ["EKG", /\b(ekg|ecg|electrocardiogram)\b/i],
  ["x-ray", /\b(x-?ray|radiograph|xr)\b/i],
  ["labs sent", /\b(cbc|bmp|cmp|lipid panel|a1c|tsh)\b/i],
  ["mono test", /\b(monospot|mono test)\b/i],
];

function dataLevel(sents: string[]) {
  const items: string[] = [];
  const ev: string[] = [];
  for (const [name, re] of TESTS) {
    const hit = find(sents, re);
    if (hit.length) { items.push(name); ev.push(hit[0]); }
  }
  const external = find(sents, /\b(reviewed (outside|prior|external|er|ed|hospital|specialist) (records|notes|labs)|records from)\b/i);
  if (external.length) { items.push("external records"); ev.push(external[0]); }
  const historian = find(sents, /\b(history (obtained|provided|given) (from|by)|per (mother|mom|father|dad|parent|caregiver|spouse|ems)|(mother|mom|father|dad|parent|caregiver) (reports|states))\b/i);
  if (historian.length) { items.push("independent historian"); ev.push(historian[0]); }
  const interp = find(sents, /\b(my (own )?(read|interpretation)|i (personally )?(reviewed|interpreted) the (x-?ray|images|ekg|ecg|film)|independent(ly)? interpret)/i);
  const discuss = find(sents, /\b(discussed (with|case with) (dr|radiolog|cardiolog|orthoped|on-call|specialist))/i);
  if (interp.length) ev.push(interp[0]);
  if (discuss.length) ev.push(discuss[0]);
  // Moderate: 3 items from tests/records/historian, OR independent interpretation, OR discussion with an external physician.
  if (items.length >= 3 || interp.length || discuss.length) return { level: "moderate" as MdmLevel, items, ev };
  // Low: 2 items, or an independent historian.
  if (items.length >= 2 || items.includes("independent historian")) return { level: "low" as MdmLevel, items, ev };
  return { level: "straightforward" as MdmLevel, items, ev };
}

// ---------- MDM: risk ----------
const RX = /\b(prescrib\w*|rx\b|e-?prescribed|sent to pharmacy|start(ed)? (on )?(amoxicillin|augmentin|azithromycin|cephalexin|keflex|doxycycline|nitrofurantoin|macrobid|bactrim|prednisone|tamiflu|oseltamivir|albuterol|ondansetron|zofran|fluticasone|cefdinir|ciprofloxacin|metformin|lisinopril)|(amoxicillin|augmentin|azithromycin|cephalexin|keflex|doxycycline|nitrofurantoin|macrobid|bactrim|prednisone|tamiflu|oseltamivir|ondansetron|zofran|cefdinir|ciprofloxacin)\b.*\b(mg|bid|tid|daily|x ?\d+ ?days?))/i;
function riskLevel(sents: string[]) {
  const high = find(sents, /\b(sent to (the )?(er|ed|emergency)|transfer(red)? to (er|ed|hospital)|admit|hospitaliz|decision (regarding|re) hospitalization|call(ed)? 911)\b/i);
  if (high.length) return { level: "high" as MdmLevel, ev: high.slice(0, 1) };
  const rx = find(sents, RX);
  if (rx.length) return { level: "moderate" as MdmLevel, ev: rx.slice(0, 1) };
  const otc = find(sents, /\b(otc|over the counter|ibuprofen|acetaminophen|tylenol|motrin|advil|fluids|rest|supportive care|saline)\b/i);
  if (otc.length) return { level: "low" as MdmLevel, ev: otc.slice(0, 1) };
  return { level: "straightforward" as MdmLevel, ev: [] };
}

// Two of three elements: the level is the middle value of the three.
function mdmLevel(p: MdmLevel, d: MdmLevel, r: MdmLevel): MdmLevel {
  const sorted = [p, d, r].map((x) => RANK[x]).sort((a, b) => a - b);
  return LEVELS[sorted[1]];
}

// ---------- add-ons ----------
type AddOn = { code: string; label: string; re: RegExp; alt?: string[]; procedure?: boolean };
const ADDONS: AddOn[] = [
  { code: "87880", label: "rapid strep test (add QW if CLIA-waived)", re: TESTS[0][1] },
  { code: "87804", label: "rapid flu test (often x2: flu A and flu B)", re: TESTS[1][1], alt: ["87502"] },
  { code: "87811", label: "COVID antigen test", re: TESTS[2][1], alt: ["87426", "87635"] },
  { code: "81002", label: "urinalysis dipstick", re: TESTS[3][1], alt: ["81003", "81000", "81001"] },
  { code: "82962", label: "fingerstick glucose", re: TESTS[4][1], alt: ["82947"] },
  { code: "93000", label: "EKG with interpretation", re: TESTS[5][1], alt: ["93005", "93010"] },
  { code: "86308", label: "mono test", re: TESTS[8][1] },
  { code: "96372", label: "IM/subcutaneous injection administration", re: /\b(im|intramuscular|subq|subcutaneous)\b.*\b(given|administered|injection|inj)\b|\b(injection|inj)\b.*\b(given|administered)\b|\b(toradol|ketorolac|rocephin|ceftriaxone|decadron|dexamethasone|solu-?medrol|kenalog|depo-?medrol)\b.*\b(im|given|administered)\b/i, procedure: true },
  { code: "J1885", label: "ketorolac (Toradol) drug supply, per 15 mg", re: /\b(toradol|ketorolac)\b.*\b(im|given|administered|mg)\b/i },
  { code: "J0696", label: "ceftriaxone (Rocephin) drug supply, per 250 mg", re: /\b(rocephin|ceftriaxone)\b.*\b(im|given|administered|mg)\b/i },
  { code: "J1100", label: "dexamethasone (Decadron) drug supply, per 1 mg", re: /\b(decadron|dexamethasone)\b.*\b(im|given|administered|mg)\b/i },
  { code: "94640", label: "nebulizer treatment", re: /\b(neb(ulizer)?|duoneb|albuterol neb)\b.*\b(treatment|given|administered|tx)\b|\bbreathing treatment\b/i, procedure: true },
  { code: "73610", label: "ankle x-ray, 3+ views (confirm views)", re: /\bankle\b.*\b(x-?ray|xr|radiograph)|\b(x-?ray|xr|radiograph)\b.*\bankle\b/i, alt: ["73600"] },
  { code: "73110", label: "wrist x-ray, 3+ views (confirm views)", re: /\bwrist\b.*\b(x-?ray|xr|radiograph)|\b(x-?ray|xr|radiograph)\b.*\bwrist\b/i, alt: ["73100"] },
  { code: "71046", label: "chest x-ray, 2 views (confirm views)", re: /\bchest\b.*\b(x-?ray|xr|radiograph|cxr)|\bcxr\b/i, alt: ["71045"] },
  { code: "29125", label: "short arm splint", re: /\b(short arm|forearm|wrist|volar)\b.*\bsplint/i, alt: ["29105", "29126"], procedure: true },
  { code: "29515", label: "short leg splint", re: /\b(short leg|ankle|posterior leg)\b.*\bsplint/i, alt: ["29505"], procedure: true },
  { code: "12001", label: "simple laceration repair, 2.5 cm or less (confirm length and site)", re: /\b(laceration)\b.*\b(repair|sutur|closed|steri|dermabond|staple)|\b(sutured|sutures placed)\b/i, alt: ["12002", "12004", "12011", "12013", "12031", "12032", "12051"], procedure: true },
  { code: "10060", label: "abscess incision and drainage", re: /\b(i&d|i ?& ?d|incision and drainage)\b/i, procedure: true },
];

const base = (c: string) => c.toUpperCase().split(/[-\s]/)[0];
const hasMod = (c: string, m: string) => c.toUpperCase().split(/[-\s]/).slice(1).includes(m);

export function precheckVisit(v: Visit): VisitResult {
  const sents = sentences(v.note);
  const billedBase = v.billed.map(base);
  const flags: Flag[] = [];

  const p = problemsLevel(v.note, sents), d = dataLevel(sents), r = riskLevel(sents);
  const level = mdmLevel(p.level, d.level, r.level);
  const mdmCode: string = EM[v.patient_type][level];

  let timeCode: string | null = null;
  if (v.minutes) for (const [code, min] of TIME[v.patient_type]) if (v.minutes >= min) { timeCode = code; break; }
  const supported = timeCode && emRank(timeCode) > emRank(mdmCode) ? timeCode : mdmCode;

  const billedEm = v.billed.find((c) => EM_CODES.has(base(c))) ?? null;
  if (billedEm) {
    const b = base(billedEm);
    const why = [
      `problems: ${p.level}`, `data: ${d.level}${d.items.length ? ` (${d.items.join(", ")})` : ""}`, `risk: ${r.level}`,
      ...(timeCode ? [`time: ${v.minutes} min supports ${timeCode}`] : []),
    ];
    const evidence = [...p.ev, ...d.ev, ...r.ev].slice(0, 4);
    if (emRank(b) < emRank(supported))
      flags.push({ type: "under_coded", code: supported, message: `Billed ${b}; the note supports ${supported} (${why.join("; ")}).`, evidence });
    else if (emRank(b) > emRank(supported))
      flags.push({ type: "over_coded", code: supported, message: `Billed ${b}; the note only supports ${supported} (${why.join("; ")}). Add the missing documentation or lower the level.`, evidence });
  }

  let procedureFound = false;
  for (const a of ADDONS) {
    const hit = find(sents, a.re);
    if (!hit.length) continue;
    const billedAlready = [a.code, ...(a.alt ?? [])].some((c) => billedBase.includes(c));
    if (a.procedure) procedureFound = true;
    if (!billedAlready) flags.push({ type: "missed_addon", code: a.code, message: `Documented but not billed: ${a.label}.`, evidence: hit.slice(0, 1) });
  }
  if (!procedureFound) procedureFound = billedBase.some((c) => ADDONS.some((a) => a.procedure && (a.code === c || a.alt?.includes(c))));

  if (billedEm && procedureFound && !hasMod(billedEm, "25"))
    flags.push({ type: "missing_modifier", code: `${base(billedEm)}-25`, message: "E/M billed with a same-day procedure: add modifier 25 if the visit was a separate, significant evaluation.", evidence: [] });

  return {
    visit_id: v.visit_id,
    billed_em: billedEm ? base(billedEm) : null,
    supported_em: supported,
    mdm: { problems: p.level, data: d.level, risk: r.level, level },
    time_supports: timeCode,
    flags,
  };
}

export function precheckBatch(visits: Visit[]) {
  const results = visits.map(precheckVisit);
  const count = (t: Flag["type"]) => results.reduce((n, r) => n + r.flags.filter((f) => f.type === t).length, 0);
  return {
    visits: results.length,
    visits_flagged: results.filter((r) => r.flags.length).length,
    under_coded: count("under_coded"),
    over_coded: count("over_coded"),
    missed_addons: count("missed_addon"),
    missing_modifiers: count("missing_modifier"),
    results,
    disclaimer: "Suggestions only. A certified coder or the treating clinician must confirm each change against the full record before a claim is changed.",
  };
}
