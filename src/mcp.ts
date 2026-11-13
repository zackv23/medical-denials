import type { Env } from "./lib";
import { CLAIM_STATUSES, uid } from "./lib";
import { carcInfo, draftAppeal, parse835 } from "./eras";
import { importDenials } from "./claims";

const TOOLS = [
  { name: "get_summary", description: "Totals of denied revenue and claim counts by status for the practice.", inputSchema: { type: "object", properties: {} } },
  { name: "list_claims", description: "List denied claims. Optional status filter.", inputSchema: { type: "object", properties: { status: { type: "string", enum: CLAIM_STATUSES }, limit: { type: "number" } } } },
  { name: "get_claim", description: "Get one claim by its internal id or claim_id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "update_claim_status", description: "Set a claim's workflow status and optionally add notes.", inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: CLAIM_STATUSES }, notes: { type: "string" } }, required: ["id", "status"] } },
  { name: "add_denial", description: "Record a denied claim manually.", inputSchema: { type: "object", properties: { claim_id: { type: "string" }, carc: { type: "string" }, denied_amount: { type: "number" }, payer_icn: { type: "string" }, payer: { type: "string" }, notes: { type: "string" } }, required: ["claim_id", "carc", "denied_amount"] } },
  { name: "parse_835", description: "Parse raw X12 835 text into denials; set import=true to save them.", inputSchema: { type: "object", properties: { edi_text: { type: "string" }, import: { type: "boolean" } }, required: ["edi_text"] } },
  { name: "draft_appeal", description: "Draft an appeal letter for a claim (human review required).", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "list_connections", description: "List connected EHR/EMR/practice-management/billing systems and their status.", inputSchema: { type: "object", properties: {} } },
];

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
const ok = (id: any, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: any, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

async function findClaim(env: Env, practiceId: string, id: string) {
  return env.DB.prepare("SELECT * FROM claims WHERE practice_id=? AND (id=? OR claim_id=?) ORDER BY created_at LIMIT 1").bind(practiceId, id, id).first<any>();
}

async function callTool(env: Env, practiceId: string, practiceName: string, name: string, a: any) {
  const db = env.DB;
  switch (name) {
    case "get_summary": {
      const rows = await db.prepare("SELECT status, COUNT(*) n, SUM(denied_cents) cents FROM claims WHERE practice_id=? GROUP BY status").bind(practiceId).all();
      return text(rows.results);
    }
    case "list_claims": {
      const lim = Math.min(Number(a.limit) || 50, 200);
      const q = a.status ? db.prepare("SELECT * FROM claims WHERE practice_id=? AND status=? ORDER BY created_at DESC LIMIT ?").bind(practiceId, a.status, lim)
        : db.prepare("SELECT * FROM claims WHERE practice_id=? ORDER BY created_at DESC LIMIT ?").bind(practiceId, lim);
      return text((await q.all()).results);
    }
    case "get_claim": {
      const c = await findClaim(env, practiceId, String(a.id));
      return c ? text(c) : { ...text("Claim not found"), isError: true };
    }
    case "update_claim_status": {
      if (!CLAIM_STATUSES.includes(a.status)) return { ...text("Invalid status"), isError: true };
      const c = await findClaim(env, practiceId, String(a.id));
      if (!c) return { ...text("Claim not found"), isError: true };
      await db.prepare("UPDATE claims SET status=?, notes=COALESCE(?, notes), updated_at=datetime('now') WHERE id=?").bind(a.status, a.notes ?? null, c.id).run();
      return text(`Claim ${c.claim_id} -> ${a.status}`);
    }
    case "add_denial": {
      const info = carcInfo(String(a.carc));
      const n = await importDenials(env, practiceId, [{ claim_id: String(a.claim_id), payer_icn: a.payer_icn ?? "", billed_cents: 0, paid_cents: 0, denied_cents: Math.round(Number(a.denied_amount) * 100), carc: String(a.carc), group: "CO", category: info.category, recommended_action: info.action }], "mcp", null, a.payer, a.notes);
      return text(`Imported ${n} denial(s)`);
    }
    case "parse_835": {
      const d = parse835(String(a.edi_text));
      if (a.import) return text({ imported: await importDenials(env, practiceId, d, "mcp", null), denials: d });
      return text(d);
    }
    case "draft_appeal": {
      const c = await findClaim(env, practiceId, String(a.id));
      return c ? text(draftAppeal(c, practiceName)) : { ...text("Claim not found"), isError: true };
    }
    case "list_connections": {
      const r = await db.prepare("SELECT id, system_name, category, status, created_at FROM connections WHERE practice_id=?").bind(practiceId).all();
      return text(r.results);
    }
  }
  return { ...text("Unknown tool"), isError: true };
}

export async function handleMcp(env: Env, practiceId: string, practiceName: string, body: Rpc | Rpc[]) {
  const one = async (m: Rpc) => {
    if (m.id === undefined) return null; // notification
    try {
      switch (m.method) {
        case "initialize":
          return ok(m.id, { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "denialops", version: "0.1.0" },
            instructions: "Tools for managing a medical practice's denied claims. Contains PHI: use only within HIPAA-compliant workflows." });
        case "ping": return ok(m.id, {});
        case "tools/list": return ok(m.id, { tools: TOOLS });
        case "tools/call": return ok(m.id, await callTool(env, practiceId, practiceName, m.params?.name, m.params?.arguments ?? {}));
        default: return err(m.id, -32601, "Method not found");
      }
    } catch (e: any) {
      return err(m.id, -32603, e?.message ?? "Internal error");
    }
  };
  if (Array.isArray(body)) return (await Promise.all(body.map(one))).filter(Boolean);
  return one(body);
}
void uid;
