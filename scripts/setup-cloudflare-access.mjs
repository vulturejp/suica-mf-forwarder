#!/usr/bin/env node

const CONFIG = {
  accountId: requireEnv("CF_ACCOUNT_ID"),
  appName: process.env.ACCESS_APP_NAME || "Suica MF Forwarder Upload",
  domain: requireEnv("ACCESS_APP_DOMAIN"),
  allowedEmail: requireEnv("ACCESS_ALLOWED_EMAIL"),
  sessionDuration: process.env.ACCESS_SESSION_DURATION || "24h"
};

const token = process.env.CF_API_TOKEN;
if (!token) {
  console.error("CF_API_TOKEN is required. Example: CF_API_TOKEN=... node scripts/setup-cloudflare-access.mjs");
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

const idp = await getFirstIdentityProvider();
const existingApp = await findAccessApplication();
if (existingApp) {
  const updated = await updateAccessApplication(existingApp.id, idp?.id);
  console.log(`Updated Access application: ${updated.id}`);
} else {
  const created = await createAccessApplication(idp?.id);
  console.log(`Created Access application: ${created.id}`);
}

console.log("");
console.log(`Access protected domain: https://${CONFIG.domain}`);
console.log(`Allowed email: ${CONFIG.allowedEmail}`);

async function getFirstIdentityProvider() {
  const response = await cf(`/accounts/${CONFIG.accountId}/access/identity_providers`);
  return response.result?.[0] ?? null;
}

async function findAccessApplication() {
  const response = await cf(`/accounts/${CONFIG.accountId}/access/apps`);
  return response.result?.find((app) => app.domain === CONFIG.domain || app.name === CONFIG.appName) ?? null;
}

async function createAccessApplication(idpId) {
  const response = await cf(`/accounts/${CONFIG.accountId}/access/apps`, {
    method: "POST",
    body: JSON.stringify(buildApplicationBody(idpId))
  });
  return response.result;
}

async function updateAccessApplication(appId, idpId) {
  const response = await cf(`/accounts/${CONFIG.accountId}/access/apps/${appId}`, {
    method: "PUT",
    body: JSON.stringify(buildApplicationBody(idpId))
  });
  return response.result;
}

function buildApplicationBody(idpId) {
  const body = {
    name: CONFIG.appName,
    type: "self_hosted",
    domain: CONFIG.domain,
    session_duration: CONFIG.sessionDuration,
    auto_redirect_to_identity: false,
    app_launcher_visible: false,
    policies: [
      {
        name: "Owner",
        decision: "allow",
        precedence: 1,
        include: [
          {
            email: {
              email: CONFIG.allowedEmail
            }
          }
        ],
        exclude: [],
        require: []
      }
    ]
  };

  if (idpId) body.allowed_idps = [idpId];
  return body;
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
