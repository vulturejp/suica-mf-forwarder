#!/usr/bin/env node

const checks = [
  ["CF_API_TOKEN", Boolean(process.env.CF_API_TOKEN)],
  ["MF_EMAIL", Boolean(process.env.MF_EMAIL)],
  ["MF_PASSWORD", Boolean(process.env.MF_PASSWORD)]
];

let ok = true;
for (const [name, present] of checks) {
  console.log(`${present ? "ok" : "missing"} ${name}`);
  if (!present) ok = false;
}

if (!ok) {
  console.error("");
  console.error("Set missing values in your shell before deploy. Do not paste tokens into chat.");
  process.exit(1);
}
