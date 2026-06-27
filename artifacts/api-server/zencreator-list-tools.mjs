#!/usr/bin/env node
// List ZenCreator tools available to the Ashley_v3_Adult API key.
// Run from repo root:
//   pnpm --filter @workspace/api-server run list-zc-tools

const ZENCREATOR_BASE = "https://api.zencreator.pro/api/public/v1";

const apiKey = process.env["Ashley_v3_Adult"];
if (!apiKey) {
  console.error("ERROR: Ashley_v3_Adult Replit secret not set.");
  process.exit(1);
}

const res = await fetch(`${ZENCREATOR_BASE}/tools`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});

if (!res.ok) {
  console.error(`GET /tools failed (${res.status}): ${await res.text()}`);
  process.exit(1);
}

const tools = await res.json();

if (!Array.isArray(tools) || tools.length === 0) {
  console.log("No tools returned — check your key has `read` scope.");
  process.exit(0);
}

console.log(`\n=== ZenCreator tools (${tools.length}) ===\n`);
for (const t of tools) {
  const lock = t.trusted ? " [TRUSTED]" : "";
  console.log(`  ${t.name}${lock}`);
  if (t.description) console.log(`    ${t.description}`);
}

console.log("\n--- input_schema per tool ---\n");
for (const t of tools) {
  console.log(`[${t.name}]`);
  console.log(JSON.stringify(t.input_schema ?? {}, null, 2));
  console.log();
}
