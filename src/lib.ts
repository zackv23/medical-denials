export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  ENCRYPTION_KEY?: string;
}

export const BONUS_DEADLINE = "2026-12-31";
export const FORM_VERSION = "2026-11-v1";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) =>
  new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
export const randomHex = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
export const uid = () => crypto.randomUUID();
export async function sha256Hex(s: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

// Workers cap PBKDF2 at 100,000 iterations.
export async function hashPassword(pw: string, saltHex?: string) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return { hash: hex(bits), salt: hex(salt) };
}
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function aesKey(env: Env) {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY secret is not configured");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(env.ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptJson(env: Env, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(JSON.stringify(value)));
  return hex(iv) + ":" + hex(ct);
}
export async function decryptJson(env: Env, blob: string) {
  const [iv, ct] = blob.split(":");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(iv) }, await aesKey(env), fromHex(ct));
  return JSON.parse(dec.decode(pt));
}

/** Sign-up bonus: 1 doctor $1,000 · 2 doctors $2,500 · 3+ doctors $5,000 (in cents). */
export function bonusForDoctors(n: number) {
  if (n >= 3) return 500000;
  if (n === 2) return 250000;
  return 100000;
}

export const CLAIM_STATUSES = ["new", "in_review", "appealed", "resubmitted", "paid", "written_off"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const HIPAA_FORM_TEXT = `HIPAA AUTHORIZATION & BUSINESS ASSOCIATE AGREEMENT (BAA) ACKNOWLEDGMENT

TEMPLATE — must be reviewed by your healthcare attorney before production use.

1. Parties. The medical practice identified below (the "Covered Entity") engages DenialOps (the "Business Associate") to manage denied insurance claims on its behalf.

2. Purpose and permitted uses. The Covered Entity authorizes the Business Associate to create, receive, maintain and transmit protected health information (PHI) solely to review denied claims, prepare and submit appeals and corrected claims, communicate with payers about payment, and track claim status. These are payment and health care operations activities under 45 CFR 164.506. PHI will not be sold, used for marketing, or used to train models for other customers.

3. Minimum necessary. The Business Associate will request, access and disclose only the minimum PHI needed for the purposes above.

4. Safeguards. The Business Associate will use administrative, physical and technical safeguards consistent with the HIPAA Security Rule (45 CFR Part 164, Subpart C), including encryption in transit and at rest, access controls and audit logging.

5. Subcontractors. Any subcontractor that handles PHI must agree in writing to the same restrictions and safeguards.

6. Breach and incident reporting. The Business Associate will report any use or disclosure of PHI not permitted by this agreement, and any security incident or breach of unsecured PHI, to the Covered Entity without unreasonable delay and as required by 45 CFR 164.410.

7. Individual rights. The Business Associate will help the Covered Entity respond to patient requests for access, amendment and an accounting of disclosures.

8. Records and audit. The Business Associate will make its internal practices, books and records relating to PHI available to the Secretary of HHS as required.

9. Term and return of PHI. This agreement lasts while services are provided. When the account is deleted or services end, the Business Associate will return or destroy all PHI where feasible; where not feasible, protections continue for as long as PHI is retained.

10. Release. The Covered Entity releases the Business Associate to contact payers, clearinghouses and billing vendors on its behalf, and to receive claim and remittance data from the practice management, EHR/EMR and billing systems it connects.

By signing, the signer confirms they are authorized to bind the Covered Entity to this agreement.`;
