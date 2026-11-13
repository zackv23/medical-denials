// Shared helpers. All dynamic text is inserted via esc() or textContent (EDI data is untrusted).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
async function api(path, opts = {}) {
  const o = { credentials: "same-origin", ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers = { "content-type": "application/json", ...o.headers }; o.body = JSON.stringify(o.body); }
  const r = await fetch(path, o);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || "Request failed"); e.status = r.status; e.data = data; throw e; }
  return data;
}
function show(el, text, kind = "err") { el.className = "msg " + kind; el.textContent = text; el.hidden = false; }
async function me({ required = true } = {}) {
  try { return await api("/api/me"); }
  catch (e) { if (required && e.status === 401) location.href = "/login.html"; return null; }
}
function nav(user, here) {
  const links = user
    ? [["/dashboard.html", "Dashboard"], ["/upload.html", "Upload denials"], ["/integrations.html", "Integrations & AI"], ["/hipaa.html", "HIPAA form"], ["/account.html", "Account"]]
    : [["/#bonus", "Year-end bonus"], ["/login.html", "Log in"]];
  document.getElementById("nav").innerHTML =
    `<a class="logo" href="/">Denial<b>Ops</b></a><nav aria-label="Main">` +
    links.map(([h, t]) => `<a href="${h}" ${here === h ? 'aria-current="page"' : ""}>${t}</a>`).join("") + `</nav>` +
    (user ? `<button class="btn ghost sm" id="logout">Log out</button>` : `<a class="btn sm" href="/signup.html">Sign up</a>`);
  const lo = document.getElementById("logout");
  if (lo) lo.onclick = async () => { await api("/api/auth/logout", { method: "POST" }); location.href = "/"; };
}
