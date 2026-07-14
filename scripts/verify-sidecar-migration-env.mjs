#!/usr/bin/env node

const REQUIRED = [
  "DATABASE_URL",
  "API_AUTH_KEY",
  "API_SECRET",
  "ADMIN_API_KEY",
  "SESSION_SECRET",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
];

const PROVIDER_GROUPS = [
  {
    name: "Anthropic",
    when: () => (process.env.ASHLEY_TEXT_PROVIDER ?? "gemini") === "anthropic",
    required: ["AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "AI_INTEGRATIONS_ANTHROPIC_API_KEY"],
  },
  {
    name: "Gemini",
    when: () => (process.env.ASHLEY_TEXT_PROVIDER ?? "gemini") === "gemini",
    required: ["AI_INTEGRATIONS_GEMINI_BASE_URL", "AI_INTEGRATIONS_GEMINI_API_KEY"],
  },
];

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
for (const group of PROVIDER_GROUPS) {
  if (group.when()) {
    for (const name of group.required) {
      if (!process.env[name]?.trim()) missing.push(name);
    }
  }
}

const uniqueMissing = [...new Set(missing)].sort();
if (uniqueMissing.length > 0) {
  console.error("Ashley Sidecar migration environment is incomplete.");
  for (const name of uniqueMissing) console.error(`- ${name}`);
  process.exit(1);
}

if ((process.env.ASHLEY_RUNTIME_REPLICAS ?? "1") !== "1") {
  console.error("ASHLEY_RUNTIME_REPLICAS must remain 1 until distributed scheduler and voice-session locking exist.");
  process.exit(1);
}

console.log("Ashley Sidecar migration environment check passed.");
console.log(`Text provider: ${process.env.ASHLEY_TEXT_PROVIDER ?? "gemini"}`);
console.log("Runtime replicas: 1");
