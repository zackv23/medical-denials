import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  type Env, BONUS_DEADLINE, CLAIM_STATUSES, FORM_VERSION, HIPAA_FORM_TEXT, SPECIALTIES, SPECIALTY_LABELS, bonusForDoctors,
  PREAUTH_CARCS, decryptJson, encryptJson, feesAndCredit, hashPassword, randomHex, safeEqual, sha256Hex, uid,
} from "./lib";
import { carcInfo, draftAppeal, looksLike835, parse835, parseCsv, type Denial } from "./eras";
import { importDenials } from "./claims";
import { handleMcp } from "./mcp";

type Vars = { user: { id: string; email: string; name: string; practice_id: string }; practice: { id: string; name: string; doctor_count: number; bonus_cents: number; specialty: string } };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
const SESSION_DAYS = 7;
const MAX_UPLOAD = 25 * 1024 * 1024;
const ip = (c: C) => c.req.header("cf-connecting-ip") ?? "unknown";
const isoPlus = (ms: number) => new Date(Date.now() + ms).toISOString();

async function audit(c: C, practiceId: string | null, userId: string | null, action: string, detail?: string) {
  await c.env.DB.prepare("INSERT INTO audit_log (practice_id,user_id,action,detail,ip) VALUES (?,?,?,?,?)")
    .bind(practiceId, userId, action, detail ?? null, ip(c)).run();
}

// Basic CSRF defence: state-changing requests must be same-origin.
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    const path = new URL(c.req.url).pathname;
    const machine = path === "/api/ingest" || path.startsWith("/api/connect/");
    if (origin && new URL(origin).host !== new URL(c.req.url).host && !machine) return c.json({ error: "cross-origin request blocked" }, 403);
  }
  await next();
});

// ---------- auth ----------
async function startSession(c: C, userId: string) {
  const token = randomHex(32);
  await c.env.DB.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)")
    .bind(await sha256Hex(token), userId, isoPlus(SESSION_DAYS * 864e5)).run();
  setCookie(c, "session", token, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
}

const requireAuth = async (c: C, next: () => Promise<void>) => {
  const token = getCookie(c, "session");
  if (!token) return c.json({ error: "unauthenticated" }, 401);
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.practice_id, p.name pname, p.doctor_count, p.bonus_cents, p.specialty
     FROM sessions s JOIN users u ON u.id=s.user_id JOIN practices p ON p.id=u.practice_id
     WHERE s.token_hash=? AND s.expires_at > ?`).bind(await sha256Hex(token), new Date().toISOString()).first<any>();
  if (!row) return c.json({ error: "unauthenticated" }, 401);
  c.set("user", { id: row.id, email: row.email, name: row.name, practice_id: row.practice_id });
  c.set("practice", { id: row.practice_id, name: row.pname, doctor_count: row.doctor_count, bonus_cents: row.bonus_cents, specialty: row.specialty ?? "other" });
  await next();
};

const hipaaSigned = async (c: C) =>
  !!(await c.env.DB.prepare("SELECT 1 x FROM hipaa_forms WHERE practice_id=? AND form_version=?").bind(c.get("practice").id, FORM_VERSION).first());

app.post("/api/auth/signup", async (c: C) => {
  const b = await c.req.json<any>().catch(() => ({}));
  const email = String(b.email ?? "").trim().toLowerCase();
  const name = String(b.name ?? "").trim();
  const practiceName = String(b.practice_name ?? "").trim();
  const doctors = Math.floor(Number(b.doctor_count));
  const specialty = (SPECIALTIES as readonly string[]).includes(String(b.specialty ?? "")) ? String(b.specialty) : "other";
  const pw = String(b.password ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "Enter a valid email." }, 400);
  if (!name || !practiceName) return c.json({ error: "Your name and practice name are required." }, 400);
  if (!(doctors >= 1 && doctors <= 1000)) return c.json({ error: "Enter the number of doctors (1 or more)." }, 400);
  if (pw.length < 12) return c.json({ error: "Password must be at least 12 characters." }, 400);
  if (await c.env.DB.prepare("SELECT 1 x FROM users WHERE email=?").bind(email).first()) return c.json({ error: "An account with that email already exists." }, 409);
  const practiceId = uid(), userId = uid(), { hash, salt } = await hashPassword(pw);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO practices (id,name,doctor_count,bonus_cents,specialty) VALUES (?,?,?,?,?)").bind(practiceId, practiceName, doctors, bonusForDoctors(doctors), specialty),
    c.env.DB.prepare("INSERT INTO users (id,practice_id,email,name,password_hash,password_salt) VALUES (?,?,?,?,?,?)").bind(userId, practiceId, email, name, hash, salt),
  ]);
  await startSession(c, userId);
  await audit(c, practiceId, userId, "signup");
  return c.json({ ok: true });
});

app.post("/api/auth/login", async (c: C) => {
  const b = await c.req.json<any>().catch(() => ({}));
  const email = String(b.email ?? "").trim().toLowerCase();
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first<any>();
  // Hash even when user is missing to keep timing uniform.
  const { hash } = await hashPassword(String(b.password ?? ""), u?.password_salt);
  if (!u || !safeEqual(hash, u.password_hash)) { await audit(c, u?.practice_id ?? null, u?.id ?? null, "login_failed"); return c.json({ error: "Incorrect email or password." }, 401); }
  await startSession(c, u.id);
  await audit(c, u.practice_id, u.id, "login");
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c: C) => {
  const token = getCookie(c, "session");
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256Hex(token)).run();
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

app.use("/api/me", requireAuth); app.use("/api/account", requireAuth); app.use("/api/hipaa", requireAuth);
app.use("/api/summary", requireAuth); app.use("/api/claims/*", requireAuth); app.use("/api/claims", requireAuth);
app.use("/api/uploads", requireAuth); app.use("/api/files/*", requireAuth); app.use("/api/files", requireAuth);
app.use("/api/tokens/*", requireAuth); app.use("/api/tokens", requireAuth);
app.use("/api/connections/*", requireAuth); app.use("/api/connections", requireAuth);

app.get("/api/me", async (c: C) => c.json({ user: c.get("user"), practice: c.get("practice"), hipaa_signed: await hipaaSigned(c), bonus_deadline: BONUS_DEADLINE }));

app.delete("/api/account", async (c: C) => {
  const b = await c.req.json<any>().catch(() => ({}));
  const u = c.get("user"), p = c.get("practice");
  if (b.confirm !== "DELETE") return c.json({ error: 'Type DELETE to confirm.' }, 400);
  const row = await c.env.DB.prepare("SELECT password_hash, password_salt FROM users WHERE id=?").bind(u.id).first<any>();
  const { hash } = await hashPassword(String(b.password ?? ""), row.password_salt);
  if (!safeEqual(hash, row.password_hash)) return c.json({ error: "Incorrect password." }, 403);
  // Remove stored files, then every row belonging to the practice (cascades).
  let cursor: string | undefined;
  do {
    const l = await c.env.FILES.list({ prefix: `${p.id}/`, cursor });
    if (l.objects.length) await c.env.FILES.delete(l.objects.map((o) => o.key));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  await audit(c, null, null, "account_deleted", `practice ${p.id}`); // no PHI, no link to deleted rows
  await c.env.DB.prepare("DELETE FROM audit_log WHERE practice_id=?").bind(p.id).run();
  await c.env.DB.prepare("DELETE FROM practices WHERE id=?").bind(p.id).run();
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

// ---------- HIPAA form ----------
app.get("/api/hipaa", async (c: C) => {
  const signed = await c.env.DB.prepare("SELECT signer_name, signer_title, entity_name, signed_at, form_version FROM hipaa_forms WHERE practice_id=? ORDER BY signed_at DESC LIMIT 1").bind(c.get("practice").id).first();
  return c.json({ form_version: FORM_VERSION, text: HIPAA_FORM_TEXT, entity_name: c.get("practice").name, signed });
});
app.post("/api/hipaa", async (c: C) => {
  const b = await c.req.json<any>().catch(() => ({}));
  const f = (k: string) => String(b[k] ?? "").trim();
  if (!f("signer_name") || !f("signer_title") || !f("signature")) return c.json({ error: "Name, title and signature are required." }, 400);
  if (f("signature").toLowerCase() !== f("signer_name").toLowerCase()) return c.json({ error: "Signature must match the signer's full name." }, 400);
  if (b.agree !== true) return c.json({ error: "You must check the agreement box." }, 400);
  const p = c.get("practice");
  await c.env.DB.prepare("INSERT INTO hipaa_forms (id,practice_id,form_version,entity_name,signer_name,signer_title,npi,signature,ip,user_agent) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(uid(), p.id, FORM_VERSION, f("entity_name") || p.name, f("signer_name"), f("signer_title"), f("npi") || null, f("signature"), ip(c), c.req.header("user-agent") ?? null).run();
  await audit(c, p.id, c.get("user").id, "hipaa_signed", FORM_VERSION);
  return c.json({ ok: true });
});

// ---------- dashboard ----------
app.get("/api/summary", async (c: C) => {
  const p = c.get("practice");
  const by = await c.env.DB.prepare("SELECT status, COUNT(*) n, COALESCE(SUM(denied_cents),0) cents FROM claims WHERE practice_id=? GROUP BY status").bind(p.id).all<any>();
  const conn = await c.env.DB.prepare("SELECT COUNT(*) n FROM connections WHERE practice_id=?").bind(p.id).first<any>();
  const files = await c.env.DB.prepare("SELECT COUNT(*) n FROM files WHERE practice_id=?").bind(p.id).first<any>();
  const toks = await c.env.DB.prepare("SELECT COUNT(*) n FROM api_tokens WHERE practice_id=?").bind(p.id).first<any>();
  const signed = await hipaaSigned(c);
  const split = await c.env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN carc IN (${PREAUTH_CARCS.map(() => "?").join(",")}) THEN denied_cents END),0) pre, COALESCE(SUM(CASE WHEN carc NOT IN (${PREAUTH_CARCS.map(() => "?").join(",")}) THEN denied_cents END),0) other FROM claims WHERE practice_id=?`).bind(...PREAUTH_CARCS, ...PREAUTH_CARCS, p.id).first<any>();
  return c.json({
    billing: { preauth_denied_cents: split!.pre, other_denied_cents: split!.other, ...feesAndCredit(split!.pre, split!.other, p.bonus_cents) },
    by_status: by.results,
    total_denied_cents: by.results.reduce((s, r) => s + r.cents, 0),
    recovered_cents: by.results.filter((r) => r.status === "paid").reduce((s, r) => s + r.cents, 0),
    specialty: p.specialty, specialty_label: SPECIALTY_LABELS[p.specialty] ?? "General / Other",
    bonus_cents: p.bonus_cents, bonus_deadline: BONUS_DEADLINE,
    steps: [
      { key: "account", label: "Create your account", done: true, href: null },
      { key: "hipaa", label: "Sign the HIPAA release form", done: signed, href: "/hipaa.html" },
      { key: "connect", label: "Connect your EHR / practice management / billing system", done: conn!.n > 0, href: "/integrations.html" },
      { key: "upload", label: "Upload your first denials", done: files!.n > 0, href: "/upload.html" },
      { key: "ai", label: "Connect an AI assistant (MCP)", done: toks!.n > 0, href: "/integrations.html#mcp" },
    ],
  });
});

app.get("/api/claims", async (c: C) => {
  const s = c.req.query("status");
  const p = c.get("practice").id;
  const q = s && (CLAIM_STATUSES as readonly string[]).includes(s)
    ? c.env.DB.prepare("SELECT * FROM claims WHERE practice_id=? AND status=? ORDER BY created_at DESC LIMIT 500").bind(p, s)
    : c.env.DB.prepare("SELECT * FROM claims WHERE practice_id=? ORDER BY created_at DESC LIMIT 500").bind(p);
  return c.json({ claims: (await q.all()).results });
});
app.post("/api/claims", async (c: C) => {
  const b = await c.req.json<any>().catch(() => ({}));
  if (!(await hipaaSigned(c))) return c.json({ error: "hipaa_required" }, 409);
  const claimId = String(b.claim_id ?? "").trim(), carc = String(b.carc ?? "").trim(), amt = Math.round(Number(b.denied_amount) * 100);
  if (!claimId || !carc || !(amt > 0)) return c.json({ error: "claim_id, carc and a positive denied_amount are required." }, 400);
  const i = carcInfo(carc);
  await importDenials(c.env, c.get("practice").id, [{ claim_id: claimId, payer_icn: String(b.payer_icn ?? ""), billed_cents: 0, paid_cents: 0, denied_cents: amt, carc, group: "CO", category: i.category, recommended_action: i.action }], "manual", null, b.payer, b.notes);
  return c.json({ ok: true });
});
app.patch("/api/claims/:id", async (c: C) => {
  const b = await c.req.json<any>().catch(() => ({}));
  if (b.status && !(CLAIM_STATUSES as readonly string[]).includes(b.status)) return c.json({ error: "invalid status" }, 400);
  const r = await c.env.DB.prepare("UPDATE claims SET status=COALESCE(?,status), notes=COALESCE(?,notes), updated_at=datetime('now') WHERE id=? AND practice_id=?")
    .bind(b.status ?? null, b.notes ?? null, c.req.param("id"), c.get("practice").id).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
app.get("/api/claims/:id/appeal", async (c: C) => {
  const cl = await c.env.DB.prepare("SELECT * FROM claims WHERE id=? AND practice_id=?").bind(c.req.param("id"), c.get("practice").id).first<any>();
  return cl ? c.json({ letter: draftAppeal(cl, c.get("practice").name, c.get("practice").specialty) }) : c.json({ error: "not found" }, 404);
});

// ---------- uploads ----------
app.post("/api/uploads", async (c: C) => {
  if (!(await hipaaSigned(c))) return c.json({ error: "hipaa_required" }, 409);
  const p = c.get("practice");
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) return c.json({ error: "Choose a file to upload." }, 400);
  if (file.size > MAX_UPLOAD) return c.json({ error: "File is larger than 25 MB." }, 413);
  const fileId = uid();
  const safeName = file.name.replace(/[^\w.\- ]/g, "_").slice(0, 120) || "upload";
  const key = `${p.id}/${fileId}/${safeName}`;
  const buf = await file.arrayBuffer();
  await c.env.FILES.put(key, buf, { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  let kind = "document", imported = 0, denials: Denial[] = [];
  const looksText = /\.(edi|835|txt|csv|x12)$/i.test(safeName) || file.type.startsWith("text/");
  if (looksText) {
    const t = new TextDecoder().decode(buf);
    try {
      if (looksLike835(t)) { kind = "835"; denials = parse835(t); }
      else if (/\.csv$/i.test(safeName)) { kind = "csv"; denials = parseCsv(t); }
    } catch (e: any) { await c.env.FILES.delete(key); return c.json({ error: e.message }, 400); }
  }
  await c.env.DB.prepare("INSERT INTO files (id,practice_id,r2_key,filename,content_type,size,kind) VALUES (?,?,?,?,?,?,?)")
    .bind(fileId, p.id, key, safeName, file.type || null, file.size, kind).run();
  if (denials.length) {
    imported = await importDenials(c.env, p.id, denials, "upload", fileId);
    await c.env.DB.prepare("UPDATE files SET claims_imported=? WHERE id=?").bind(imported, fileId).run();
  }
  await audit(c, p.id, c.get("user").id, "file_uploaded", `${kind} ${fileId}`);
  return c.json({ ok: true, file_id: fileId, kind, claims_imported: imported, denied_cents: denials.reduce((s, d) => s + d.denied_cents, 0) });
});
app.get("/api/files", async (c: C) =>
  c.json({ files: (await c.env.DB.prepare("SELECT id,filename,kind,size,claims_imported,created_at FROM files WHERE practice_id=? ORDER BY created_at DESC LIMIT 200").bind(c.get("practice").id).all()).results }));
app.get("/api/files/:id/download", async (c: C) => {
  const f = await c.env.DB.prepare("SELECT r2_key, filename, content_type FROM files WHERE id=? AND practice_id=?").bind(c.req.param("id"), c.get("practice").id).first<any>();
  if (!f) return c.json({ error: "not found" }, 404);
  const o = await c.env.FILES.get(f.r2_key);
  if (!o) return c.json({ error: "not found" }, 404);
  await audit(c, c.get("practice").id, c.get("user").id, "file_downloaded", c.req.param("id"));
  return new Response(o.body, { headers: { "content-type": f.content_type || "application/octet-stream", "content-disposition": `attachment; filename="${f.filename}"`, "x-content-type-options": "nosniff" } });
});

// ---------- MCP API tokens ----------
app.get("/api/tokens", async (c: C) =>
  c.json({ tokens: (await c.env.DB.prepare("SELECT id,name,token_prefix,created_at,last_used_at FROM api_tokens WHERE practice_id=?").bind(c.get("practice").id).all()).results }));
app.post("/api/tokens", async (c: C) => {
  const b = await c.req.json<any>().catch(() => ({}));
  const token = "dop_" + randomHex(24);
  await c.env.DB.prepare("INSERT INTO api_tokens (id,practice_id,name,token_hash,token_prefix) VALUES (?,?,?,?,?)")
    .bind(uid(), c.get("practice").id, String(b.name || "AI assistant").slice(0, 60), await sha256Hex(token), token.slice(0, 8)).run();
  await audit(c, c.get("practice").id, c.get("user").id, "mcp_token_created");
  return c.json({ token, mcp_url: new URL("/mcp", c.req.url).toString() }); // shown once
});
app.delete("/api/tokens/:id", async (c: C) => {
  await c.env.DB.prepare("DELETE FROM api_tokens WHERE id=? AND practice_id=?").bind(c.req.param("id"), c.get("practice").id).run();
  return c.json({ ok: true });
});

app.all("/mcp", async (c: C) => {
  if (c.req.method === "GET") return c.json({ error: "Use POST with a JSON-RPC body." }, 405);
  if (c.req.method !== "POST") return c.json({ error: "method not allowed" }, 405);
  const auth = c.req.header("authorization") ?? "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const row = tok ? await c.env.DB.prepare("SELECT t.id, p.id pid, p.name pname, p.specialty FROM api_tokens t JOIN practices p ON p.id=t.practice_id WHERE t.token_hash=?").bind(await sha256Hex(tok)).first<any>() : null;
  if (!row) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: send 'Authorization: Bearer <token>'" } }, 401);
  const signed = await c.env.DB.prepare("SELECT 1 x FROM hipaa_forms WHERE practice_id=? AND form_version=?").bind(row.pid, FORM_VERSION).first();
  if (!signed) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32002, message: "HIPAA release form not signed" } }, 403);
  c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE api_tokens SET last_used_at=datetime('now') WHERE id=?").bind(row.id).run());
  const body = await c.req.json<any>().catch(() => null);
  if (!body) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  const out = await handleMcp(c.env, row.pid, row.pname, body, row.specialty ?? "other");
  return out === null || (Array.isArray(out) && !out.length) ? new Response(null, { status: 202 }) : c.json(out);
});

// ---------- EZ quick connect ----------
const SYSTEMS = ["Epic", "athenahealth", "eClinicalWorks", "NextGen", "Tebra (Kareo)", "AdvancedMD", "Practice Fusion", "ModMed", "Greenway", "CareCloud", "DrChrono", "Waystar", "Availity", "Change Healthcare", "Office Ally", "Other"];
const CATEGORIES = ["EHR", "EMR", "Practice management", "Third-party billing", "Clearinghouse"];
app.get("/api/connection-options", (c) => c.json({ systems: SYSTEMS, categories: CATEGORIES }));

app.get("/api/connections", async (c: C) =>
  c.json({ connections: (await c.env.DB.prepare("SELECT id,system_name,category,contact_email,status,link_expires_at,ingest_key_prefix,created_at FROM connections WHERE practice_id=? ORDER BY created_at DESC").bind(c.get("practice").id).all()).results }));

async function issueLink(c: C, connId: string) {
  const link = randomHex(24), ingest = "dopi_" + randomHex(24);
  await c.env.DB.prepare("UPDATE connections SET link_hash=?, link_expires_at=?, ingest_key_hash=?, ingest_key_prefix=?, updated_at=datetime('now') WHERE id=?")
    .bind(await sha256Hex(link), isoPlus(7 * 864e5), await sha256Hex(ingest), ingest.slice(0, 9), connId).run();
  const origin = new URL(c.req.url).origin;
  return { connect_url: `${origin}/connect/${link}`, ingest_url: `${origin}/api/ingest`, ingest_key: ingest, expires_in_days: 7 };
}
app.post("/api/connections", async (c: C) => {
  const b = await c.req.json<any>().catch(() => ({}));
  const sys = String(b.system_name ?? "").trim().slice(0, 80), cat = String(b.category ?? "");
  if (!sys || !CATEGORIES.includes(cat)) return c.json({ error: "Choose a system and category." }, 400);
  const id = uid();
  await c.env.DB.prepare("INSERT INTO connections (id,practice_id,system_name,category,contact_email) VALUES (?,?,?,?,?)").bind(id, c.get("practice").id, sys, cat, b.contact_email ? String(b.contact_email).slice(0, 120) : null).run();
  await audit(c, c.get("practice").id, c.get("user").id, "connection_created", sys);
  return c.json({ id, ...(await issueLink(c, id)) });
});
app.post("/api/connections/:id/link", async (c: C) => {
  const own = await c.env.DB.prepare("SELECT 1 x FROM connections WHERE id=? AND practice_id=?").bind(c.req.param("id"), c.get("practice").id).first();
  if (!own) return c.json({ error: "not found" }, 404);
  return c.json(await issueLink(c, c.req.param("id") ?? ""));
});
app.delete("/api/connections/:id", async (c: C) => {
  await c.env.DB.prepare("DELETE FROM connections WHERE id=? AND practice_id=?").bind(c.req.param("id"), c.get("practice").id).run();
  return c.json({ ok: true });
});

// Public, token-gated page + API used by the practice's EHR admin / biller.
const connByLink = async (c: C, token: string) =>
  c.env.DB.prepare("SELECT c.id, c.system_name, c.category, c.status, p.name practice FROM connections c JOIN practices p ON p.id=c.practice_id WHERE c.link_hash=? AND c.link_expires_at > ?")
    .bind(await sha256Hex(token), new Date().toISOString()).first<any>();
app.get("/connect/:token", async (c: C) => c.env.ASSETS.fetch(new Request(new URL("/connect-link.html", c.req.url))));
app.get("/api/connect/:token", async (c: C) => {
  const r = await connByLink(c, c.req.param("token") ?? "");
  return r ? c.json({ practice: r.practice, system_name: r.system_name, category: r.category, status: r.status }) : c.json({ error: "This link is invalid or has expired." }, 404);
});
app.post("/api/connect/:token", async (c: C) => {
  const r = await connByLink(c, c.req.param("token") ?? "");
  if (!r) return c.json({ error: "This link is invalid or has expired." }, 404);
  const b = await c.req.json<any>().catch(() => ({}));
  const creds = { method: String(b.method ?? "").slice(0, 40), host: String(b.host ?? "").slice(0, 200), username: String(b.username ?? "").slice(0, 200), password: String(b.password ?? "").slice(0, 500), client_id: String(b.client_id ?? "").slice(0, 200), client_secret: String(b.client_secret ?? "").slice(0, 500), notes: String(b.notes ?? "").slice(0, 1000) };
  if (!creds.method) return c.json({ error: "Choose a connection method." }, 400);
  try {
    await c.env.DB.prepare("UPDATE connections SET enc_credentials=?, status='credentials_received', updated_at=datetime('now') WHERE id=?").bind(await encryptJson(c.env, creds), r.id).run();
  } catch { return c.json({ error: "Server is not configured to store credentials securely yet." }, 500); }
  await audit(c, null, null, "connection_credentials_received", r.id);
  return c.json({ ok: true });
});

// Push ingestion for connected systems (X-Ingest-Key). Accepts raw 835 text or JSON {claims:[...]}.
app.post("/api/ingest", async (c: C) => {
  const key = c.req.header("x-ingest-key") ?? "";
  const conn = key ? await c.env.DB.prepare("SELECT id, practice_id FROM connections WHERE ingest_key_hash=?").bind(await sha256Hex(key)).first<any>() : null;
  if (!conn) return c.json({ error: "invalid ingest key" }, 401);
  if (!(await c.env.DB.prepare("SELECT 1 x FROM hipaa_forms WHERE practice_id=? AND form_version=?").bind(conn.practice_id, FORM_VERSION).first())) return c.json({ error: "hipaa_required" }, 403);
  const raw = await c.req.text();
  let denials: Denial[] = [];
  try {
    if (looksLike835(raw)) denials = parse835(raw);
    else {
      const j = JSON.parse(raw);
      denials = (j.claims ?? []).map((x: any) => { const i = carcInfo(String(x.carc)); return { claim_id: String(x.claim_id), payer_icn: String(x.payer_icn ?? ""), billed_cents: Math.round(Number(x.billed ?? 0) * 100), paid_cents: Math.round(Number(x.paid ?? 0) * 100), denied_cents: Math.round(Number(x.denied) * 100), carc: String(x.carc), group: "CO", category: i.category, recommended_action: i.action }; });
    }
  } catch { return c.json({ error: "Body must be X12 835 text or JSON {claims:[{claim_id,carc,denied}]}" }, 400); }
  const n = await importDenials(c.env, conn.practice_id, denials, "ingest", null);
  await c.env.DB.prepare("UPDATE connections SET status='connected', updated_at=datetime('now') WHERE id=?").bind(conn.id).run();
  return c.json({ ok: true, claims_imported: n });
});

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.env.ASSETS.fetch(c.req.raw)));
app.onError((e, c) => { console.error(e); return c.json({ error: "Internal error" }, 500); });
export default app;
