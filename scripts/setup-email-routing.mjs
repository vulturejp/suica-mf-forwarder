#!/usr/bin/env node

const CONFIG = {
  accountId: requireEnv("CF_ACCOUNT_ID"),
  zoneName: requireEnv("CF_ZONE_NAME"),
  routeAddress: requireEnv("EMAIL_ROUTE_ADDRESS"),
  workerName: process.env.WORKER_NAME || "suica-mf-forwarder",
  forwardToEmail: requireEnv("FORWARD_TO_EMAIL"),
  ruleName: process.env.EMAIL_RULE_NAME || "Money Forward OTP to suica-mf-forwarder"
};

const token = process.env.CF_API_TOKEN;
if (!token) {
  console.error("CF_API_TOKEN is required. Example: CF_API_TOKEN=... node scripts/setup-email-routing.mjs");
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required.`);
    process.exit(1);
  }
  return value;
}

const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json"
};

const zone = await getZone(CONFIG.zoneName);
console.log(`Zone: ${CONFIG.zoneName} (${zone.id})`);

await enableEmailRouting(zone.id);
console.log("Email Routing: enabled or already enabled");

const existingRule = await findRoutingRule(zone.id);
if (existingRule) {
  await updateRoutingRule(zone.id, existingRule.id);
  console.log(`Updated Email Routing rule: ${existingRule.id}`);
} else {
  const rule = await createRoutingRule(zone.id);
  console.log(`Created Email Routing rule: ${rule.id}`);
}

console.log("");
console.log("Next required Worker config:");
console.log(`  FORWARD_TO_EMAIL=${CONFIG.forwardToEmail}`);
console.log("");
console.log("Route:");
console.log(`  ${CONFIG.routeAddress} -> worker:${CONFIG.workerName} -> ${CONFIG.forwardToEmail}`);

async function getZone(name) {
  const response = await cf(`/zones?name=${encodeURIComponent(name)}&account.id=${CONFIG.accountId}`);
  const zone = response.result?.[0];
  if (!zone) throw new Error(`Zone not found: ${name}`);
  return zone;
}

async function enableEmailRouting(zoneId) {
  try {
    await cf(`/zones/${zoneId}/email/routing/enable`, {
      method: "POST"
    });
  } catch (error) {
    if (!String(error.message).includes("already")) throw error;
  }
}

async function findRoutingRule(zoneId) {
  const response = await cf(`/zones/${zoneId}/email/routing/rules`);
  return response.result?.find((rule) =>
    rule.matchers?.some((matcher) => matcher.field === "to" && matcher.value === CONFIG.routeAddress)
  );
}

async function createRoutingRule(zoneId) {
  const response = await cf(`/zones/${zoneId}/email/routing/rules`, {
    method: "POST",
    body: JSON.stringify(buildRuleBody())
  });
  return response.result;
}

async function updateRoutingRule(zoneId, ruleId) {
  const response = await cf(`/zones/${zoneId}/email/routing/rules/${ruleId}`, {
    method: "PUT",
    body: JSON.stringify(buildRuleBody())
  });
  return response.result;
}

function buildRuleBody() {
  return {
    name: CONFIG.ruleName,
    enabled: true,
    matchers: [
      {
        type: "literal",
        field: "to",
        value: CONFIG.routeAddress
      }
    ],
    actions: [
      {
        type: "worker",
        value: [CONFIG.workerName]
      }
    ]
  };
}

async function cf(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers ?? {})
    }
  });
  const json = await response.json();
  if (!response.ok || !json.success) {
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json;
}
