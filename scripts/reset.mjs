#!/usr/bin/env node
// Authenticated board reset. Identities are kept; every connected browser
// receives the blank board immediately.
//
//   API_URL=https://shared-canvas-api.<you>.workers.dev ADMIN_TOKEN=... npm run reset
//   API_URL=... ADMIN_TOKEN=... npm run reset -- --stats     # read-only
//   API_URL=... ADMIN_TOKEN=... npm run reset -- --yes       # skip the prompt
//
// ADMIN_TOKEN must match the Worker secret set with `wrangler secret put ADMIN_TOKEN`.
import { createInterface } from "node:readline/promises";

const api = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error("Set ADMIN_TOKEN (and API_URL for production).");
  process.exit(1);
}
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const statsRes = await fetch(`${api}/admin/stats`, { headers });
if (!statsRes.ok) {
  console.error(`stats failed: ${statsRes.status} ${await statsRes.text()}`);
  process.exit(1);
}
console.log("current:", await statsRes.json());
if (process.argv.includes("--stats")) process.exit(0);

if (!process.argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Erase every mark on ${api}? Type "reset" to confirm: `);
  rl.close();
  if (answer.trim() !== "reset") {
    console.log("aborted");
    process.exit(1);
  }
}
const res = await fetch(`${api}/admin/reset`, { method: "POST", headers, body: JSON.stringify({ confirm: "reset" }) });
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
