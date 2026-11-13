// End-to-end smoke test against `wrangler dev` (default http://localhost:8787).
const base = process.env.BASE ?? "http://localhost:8787";
let cookie = "";
const call = async (path, { method = "GET", body, headers = {}, raw } = {}) => {
  const h = { cookie, ...headers };
  let b = raw;
  if (body !== undefined) { h["content-type"] = "application/json"; b = JSON.stringify(body); }
  const r = await fetch(base + path, { method, headers: h, body: b });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, j };
};
const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(d))); if (!c) process.exitCode = 1; };
const email = `t${Date.now()}@example.com`, pw = "correct-horse-battery";
const edi = "ISA*00*          *00*          *ZZ*PAYERID        *ZZ*PROVIDERID     *261112*0430*^*00501*000000001*0*P*:~CLP*CLM-1*4*450.00*0.00*0.00*12*ICN1~CAS*CO*50*450.00~CLP*CLM-2*1*200.00*150.00*0.00*12*ICN2~CAS*CO*45*50.00~CLP*CLM-3*4*320.00*0.00*0.00*12*ICN3~CAS*CO*197*320.00~SE*8*0001~";

let r = await call("/"); ok("hero page", r.status === 200 && /\$5,000/.test(r.j));
r = await call("/api/summary"); ok("auth required", r.status === 401);
r = await call("/api/auth/signup", { method: "POST", body: { email, password: "short", name: "A", practice_name: "P", doctor_count: 3 } }); ok("weak password rejected", r.status === 400);
r = await call("/api/auth/signup", { method: "POST", body: { email, password: pw, name: "Dr Test", practice_name: "Test Clinic", doctor_count: 3 } }); ok("signup", r.status === 200, r);
r = await call("/api/me"); ok("bonus 3+ docs = $5,000", r.j.practice?.bonus_cents === 500000 && !r.j.hipaa_signed, r.j);
const fd = new FormData(); fd.append("file", new Blob([edi]), "era.edi");
r = await fetch(base + "/api/uploads", { method: "POST", headers: { cookie }, body: fd }); ok("upload blocked before HIPAA", r.status === 409);
r = await call("/api/hipaa", { method: "POST", body: { signer_name: "Dr Test", signer_title: "Owner", signature: "Dr Test", agree: true, entity_name: "Test Clinic" } }); ok("sign HIPAA", r.status === 200, r);
const fd2 = new FormData(); fd2.append("file", new Blob([edi]), "era.edi");
r = await (await fetch(base + "/api/uploads", { method: "POST", headers: { cookie }, body: fd2 })).json(); ok("835 upload: 2 denials (CARC 45 excluded), $770", r.claims_imported === 2 && r.denied_cents === 77000, r);
r = await call("/api/claims"); ok("claims listed", r.j.claims?.length === 2, r.j);
const id = r.j.claims[0].id;
r = await call("/api/claims/" + id, { method: "PATCH", body: { status: "appealed" } }); ok("update status", r.status === 200);
r = await call(`/api/claims/${id}/appeal`); ok("appeal draft", /CLAIM RECONSIDERATION/.test(r.j.letter ?? ""));
r = await call("/api/summary"); ok("summary + steps", r.j.total_denied_cents === 77000 && r.j.steps.find((s) => s.key === "upload").done, r.j);
ok("billing: 3% preauth(320) + 1/3 other(450) = $160.60, fully covered by credit", r.j.billing.fee_cents === Math.round(32000*0.03+45000/3) && r.j.billing.amount_due_cents === 0, r.j.billing);
r = await call("/api/connections", { method: "POST", body: { system_name: "Epic", category: "EHR" } }); ok("quick-connect link", r.status === 200 && r.j.connect_url && r.j.ingest_key, r);
const link = r.j.connect_url.replace(/^https?:\/\/[^/]+/, ""), key = r.j.ingest_key;
const saved = cookie; cookie = "";
r = await call("/api" + link.replace("/connect", "/connect")); ok("public connect info", r.j.system_name === "Epic", r);
r = await call("/api" + link, { method: "POST", body: { method: "SFTP / file drop", host: "sftp.x", username: "u", password: "p" } }); ok("vendor submits creds (encrypted)", r.status === 200, r);
r = await call("/api/ingest", { method: "POST", headers: { "x-ingest-key": key }, body: { claims: [{ claim_id: "CLM-9", carc: "16", denied: 99.5 }] } }); ok("ingest by key", r.j.claims_imported === 1, r);
r = await call("/api/ingest", { method: "POST", headers: { "x-ingest-key": "bad" }, body: {} }); ok("bad ingest key rejected", r.status === 401);
cookie = saved;
r = await call("/api/tokens", { method: "POST", body: { name: "Claude" } }); ok("mcp token", r.j.token?.startsWith("dop_"), r);
const tok = r.j.token, mcp = (m) => call("/mcp", { method: "POST", headers: { authorization: "Bearer " + tok }, body: m });
cookie = "";
r = await call("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }); ok("mcp unauthorized", r.status === 401);
r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }); ok("mcp initialize", r.j.result?.serverInfo?.name === "denialops", r);
r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }); ok("mcp tools/list", r.j.result?.tools?.length >= 8, r);
r = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_claims", arguments: {} } }); ok("mcp list_claims = 3", JSON.parse(r.j.result.content[0].text).length === 3, r);
cookie = saved;
r = await call("/api/auth/logout", { method: "POST" }); ok("logout", r.status === 200);
r = await call("/api/me"); ok("session gone after logout", r.status === 401);
r = await call("/api/auth/login", { method: "POST", body: { email, password: "wrong-password-xx" } }); ok("bad login rejected", r.status === 401);
r = await call("/api/auth/login", { method: "POST", body: { email, password: pw } }); ok("login", r.status === 200);
r = await call("/api/account", { method: "DELETE", body: { password: "nope", confirm: "DELETE" } }); ok("delete needs correct password", r.status === 403);
r = await call("/api/account", { method: "DELETE", body: { password: pw, confirm: "DELETE" } }); ok("delete account", r.status === 200, r);
r = await call("/api/auth/login", { method: "POST", body: { email, password: pw } }); ok("login fails after delete", r.status === 401);
r = await call("/mcp", { method: "POST", headers: { authorization: "Bearer " + tok }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }); ok("mcp token dead after delete", r.status === 401);
