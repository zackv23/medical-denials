// Runs the pre-check on the made-up sample visits and prints what it catches.
// Usage: node --experimental-strip-types scripts/precheck-samples-2026-11-27.mjs [visits.json]
import { readFileSync } from "node:fs";
import { precheckBatch } from "../src/precheck.ts";

const file = process.argv[2] ?? new URL("../samples/precheck-visits-2026-11-27.json", import.meta.url);
const { visits } = JSON.parse(readFileSync(file, "utf8"));
const out = precheckBatch(visits);
for (const r of out.results) {
  console.log(`\n${r.visit_id}: billed ${r.billed_em ?? "-"}, note supports ${r.supported_em} (MDM ${r.mdm.level})`);
  if (!r.flags.length) console.log("  OK: nothing flagged");
  for (const f of r.flags) console.log(`  ${f.type.toUpperCase()} ${f.code}: ${f.message}${f.evidence[0] ? `\n    evidence: "${f.evidence[0]}"` : ""}`);
}
console.log(`\n${out.visits_flagged} of ${out.visits} visits flagged: ${out.under_coded} under-coded, ${out.over_coded} over-coded, ${out.missed_addons} missed add-ons, ${out.missing_modifiers} missing modifier 25.`);

// Expected results for the samples, so a rules change that breaks one shows up here.
const expect = {
  "SAMPLE-UC-001": ["under_coded:99214", "missed_addon:87880"],
  "SAMPLE-UC-002": [],
  "SAMPLE-UC-003": ["missed_addon:29515", "missing_modifier:99203-25"],
  "SAMPLE-UC-004": ["under_coded:99214", "missed_addon:94640", "missing_modifier:99213-25"],
  "SAMPLE-UC-005": ["over_coded:99213"],
  "SAMPLE-PC-006": ["under_coded:99214", "missed_addon:96372", "missed_addon:J0696", "missing_modifier:99213-25"],
  "SAMPLE-UC-007": [],
};
let fail = 0;
for (const r of out.results) {
  if (!(r.visit_id in expect)) continue;
  const got = r.flags.map((f) => `${f.type}:${f.code}`).sort().join(",");
  const want = [...expect[r.visit_id]].sort().join(",");
  if (got !== want) { fail++; console.log(`FAIL ${r.visit_id}: got [${got}] want [${want}]`); }
}
console.log(fail ? `\n${fail} sample check(s) failed` : "\nPASS all sample checks");
process.exitCode = fail ? 1 : 0;
