// Pre-stages the two platform zones on Kent's Cloudflare account BEFORE the
// nameservers move (2026-10-23): placeholder records for the apex, www and the
// shop wildcard, the HTTPS settings, the www -> apex redirect, and the whole
// domain redirect from the typo domain flippingstuff.se. Idempotent: a record
// that exists is left alone, a redirect ruleset that exists is replaced.
//
// Run:  set -a; source ~/.config/chopshop/cloudflare.env; set +a; node scripts/cf-port/prestage-zones.mjs
// Ran by Mikael 2026-10-23 16:50: every line ok on both zones (the env file has a value with
// spaces, so it is sourced, never passed through xargs).
//
// The Workers' own hosts (api., admin., img., the apex at deploy) are NOT made
// here: wrangler creates those records when the production Workers deploy with
// their custom-domain routes (CP7_T3_REPORT.md, "The day the domain exists").
// The Resend records for mail.flippinstuff.se come from Resend's dashboard.

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) throw new Error("CLOUDFLARE_API_TOKEN missing (source ~/.config/chopshop/cloudflare.env)");
const API = "https://api.cloudflare.com/client/v4";
const MAIN = "8398c81a4350f45e807f7ef4610baa1a"; // flippinstuff.se
const TYPO = "dd0bd49f5c4baa32834cd91edd1ba2d5"; // flippingstuff.se

async function cf(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json();
  // A refused write is a failed run (Codex P2 on b04a3ab1): never print "ok"
  // around it and exit 0. Reads that fail throw the same way.
  if (!r.ok || !d.success) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(d.errors ?? d)}`);
  return d;
}

async function record(zone, name, type, content, comment) {
  const have = (await cf("GET", `/zones/${zone}/dns_records?name=${name}&type=${type}`)).result;
  if (have.length) { console.log(`  record ${type} ${name}: exists`); return; }
  await cf("POST", `/zones/${zone}/dns_records`, { type, name, content, proxied: true, ttl: 1, comment });
  console.log(`  record ${type} ${name}: ok`);
}

async function setting(zone, key, value) {
  await cf("PATCH", `/zones/${zone}/settings/${key}`, { value });
  console.log(`  setting ${key}=${value}: ok`);
}

const rule = (ref, description, expression, target) => ({
  ref, description, expression, action: "redirect",
  action_parameters: { from_value: { status_code: 301, preserve_query_string: true, target_url: { expression: target } } },
});

async function redirects(zone, name, rules) {
  const have = (await cf("GET", `/zones/${zone}/rulesets`)).result.filter((r) => r.phase === "http_request_dynamic_redirect");
  const body = { name, kind: "zone", phase: "http_request_dynamic_redirect", rules };
  const d = have.length
    ? await cf("PUT", `/zones/${zone}/rulesets/${have[0].id}`, body)
    : await cf("POST", `/zones/${zone}/rulesets`, body);
  console.log(`  redirect ruleset (${have.length ? "updated" : "created"}): ok`);
  for (const r of d.result.rules) console.log(`    - ${r.description} | ${r.expression}`);
}

console.log("== flippinstuff.se (main) ==");
await record(MAIN, "flippinstuff.se", "AAAA", "100::", "platform apex; placeholder, the web Worker takes the host at deploy");
await record(MAIN, "www.flippinstuff.se", "AAAA", "100::", "www -> apex redirect (Single Redirect rule)");
await record(MAIN, "*.flippinstuff.se", "AAAA", "100::", "shops: <label>.flippinstuff.se served by the web Worker (route)");
await setting(MAIN, "always_use_https", "on");
await setting(MAIN, "ssl", "strict");
await setting(MAIN, "automatic_https_rewrites", "on");
await setting(MAIN, "min_tls_version", "1.2");
await redirects(MAIN, "Flippin Stuff redirects", [
  rule("www_to_apex", "www -> naked domain", '(http.host eq "www.flippinstuff.se")', 'concat("https://flippinstuff.se", http.request.uri.path)'),
]);

console.log("== flippingstuff.se (typo, redirect zone) ==");
await record(TYPO, "flippingstuff.se", "AAAA", "100::", "redirect zone: everything 301s to flippinstuff.se");
await record(TYPO, "*.flippingstuff.se", "AAAA", "100::", "redirect zone: <label>.flippingstuff.se -> <label>.flippinstuff.se");
await setting(TYPO, "always_use_https", "on");
await setting(TYPO, "ssl", "strict");
await setting(TYPO, "min_tls_version", "1.2");
await redirects(TYPO, "flippingstuff.se -> flippinstuff.se", [
  rule("typo_apex", "apex and www -> flippinstuff.se",
    '(http.host eq "flippingstuff.se") or (http.host eq "www.flippingstuff.se")',
    'concat("https://flippinstuff.se", http.request.uri.path)'),
  rule("typo_subdomains", "subdomains -> same label on flippinstuff.se",
    '(http.host ne "flippingstuff.se") and (http.host ne "www.flippingstuff.se")',
    // Any scheme (Codex P2 on b04a3ab1: an http:// request would otherwise 301 to
    // itself, since Single Redirects run before the HTTPS upgrade): the scheme is
    // ${1} and dropped, the label ${2}, the path ${3}; the query is preserved.
    'wildcard_replace(http.request.full_uri, "*://*.flippingstuff.se/*", "https://${2}.flippinstuff.se/${3}")'),
]);
