// CP14 staging smoke: the platform subdomain routes on the staging API, as the
// platform admin. Prints statuses, labels and hostnames only; never a cookie,
// a password or a body of anything else. Env: PLATFORM_ADMIN_EMAIL (default
// micke.ohlen@gmail.com) + PLATFORM_ADMIN_PASSWORD from secrets.staging.env.
const API = "https://chopshop-api-stg.kent-ee2.workers.dev";
const WEB = "https://chopshop-web-stg.kent-ee2.workers.dev";
const email = process.env.PLATFORM_ADMIN_EMAIL || "micke.ohlen@gmail.com";
const password = process.env.PLATFORM_ADMIN_PASSWORD;
if (!password) throw new Error("PLATFORM_ADMIN_PASSWORD missing");
const TEST_SHOP = "slice-20260927"; // an active staging seed shop with no label

let cookie = "";
const results = [];
function note(name, ok, detail) { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`); }

async function api(method, path, json) {
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", origin: API, ...(cookie ? { cookie } : {}) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

// 1. health + ready
for (const p of ["/health", "/ready"]) {
  const r = await fetch(API + p); const t = await r.text();
  note(p, r.status === 200, `${r.status} ${t.trim().slice(0, 80)}`);
}

// 2. sign in
{
  const r = await fetch(`${API}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: API },
    body: JSON.stringify({ email, password }),
  });
  cookie = r.headers.getSetCookie().map((v) => v.split(";", 1)[0]).join("; ");
  note("platform sign-in", r.status === 200 && cookie.length > 0, `${r.status}`);
}

// 3. the backfilled shop
{
  const r = await api("GET", "/v1/platform/tenants/melodie-mc/subdomain");
  const s = r.body?.subdomain;
  note("GET melodie-mc subdomain", r.status === 200 && s?.label === "melodie-mc" && s?.hostname === "melodie-mc.stg-shop.invalid",
    `${r.status} label=${s?.label} hostname=${s?.hostname} base=${s?.baseDomain}`);
}

// 4. refusals
for (const [label, status, code] of [["admin", 400, "subdomain_reserved"], ["ninetone", 409, "subdomain_taken"], ["Bad_Label", 400, "subdomain_invalid"]]) {
  const r = await api("PUT", `/v1/platform/tenants/${TEST_SHOP}/subdomain`, { label });
  note(`PUT ${TEST_SHOP} label=${label}`, r.status === status && r.body?.error?.code === code, `${r.status} ${r.body?.error?.code}`);
}

// 5. set, change (grace), set back
{
  let r = await api("PUT", `/v1/platform/tenants/${TEST_SHOP}/subdomain`, { label: TEST_SHOP });
  note("PUT set label = id", r.status === 200 && r.body?.subdomain?.hostname === `${TEST_SHOP}.stg-shop.invalid`, `${r.status} hostname=${r.body?.subdomain?.hostname}`);
  r = await api("PUT", `/v1/platform/tenants/${TEST_SHOP}/subdomain`, { label: "slice-smoke" });
  const prev = r.body?.subdomain?.previous ?? [];
  note("PUT change label (grace)", r.status === 200 && r.body?.subdomain?.label === "slice-smoke" && prev.some((p) => p.hostname === `${TEST_SHOP}.stg-shop.invalid`),
    `${r.status} label=${r.body?.subdomain?.label} previous=${prev.map((p) => `${p.hostname}→${p.redirectUntil}`).join(",")}`);
  r = await api("GET", `/v1/platform/tenants/${TEST_SHOP}/subdomain`);
  note("GET after change", r.status === 200 && r.body?.subdomain?.label === "slice-smoke", `${r.status} label=${r.body?.subdomain?.label}`);
  r = await api("PUT", `/v1/platform/tenants/${TEST_SHOP}/subdomain`, { label: TEST_SHOP });
  const prev2 = r.body?.subdomain?.previous ?? [];
  note("PUT set back", r.status === 200 && r.body?.subdomain?.label === TEST_SHOP && prev2.some((p) => p.hostname === "slice-smoke.stg-shop.invalid"),
    `${r.status} label=${r.body?.subdomain?.label} previous=${prev2.map((p) => p.hostname).join(",")}`);
  r = await api("PUT", `/v1/platform/tenants/${TEST_SHOP}/subdomain`, { label: TEST_SHOP });
  note("PUT same label = no-op", r.status === 200, `${r.status}`);
  r = await api("PUT", `/v1/platform/tenants/${TEST_SHOP}/subdomain`, { label: TEST_SHOP, extra: 1 });
  note("PUT with extra key refused", r.status === 400, `${r.status}`);
  r = await api("PUT", `/v1/platform/tenants/no-such-shop/subdomain`, { label: "x" });
  note("PUT unknown shop", r.status === 404, `${r.status}`);
}

// 6. the storefront on the shared staging host still serves (web var absent: no redirect)
{
  const r = await fetch(`${WEB}/melodie-mc/`, { redirect: "manual" });
  note("web /melodie-mc/ served, not redirected", r.status === 200, `${r.status} location=${r.headers.get("location")}`);
}

const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
