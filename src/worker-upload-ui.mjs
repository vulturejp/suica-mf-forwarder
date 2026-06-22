import { Hono } from "hono";
import { parseSuicaPdfBytes } from "./suica-parser.mjs";
import { createCloudflareBrowserPage, postReadyRowsToMoneyForward } from "./money-forward-browser-run.mjs";

const BALANCE_RECONCILIATION_INTERVAL_ROWS = 5;
const BROWSER_RATE_LIMIT_COOLDOWN_SECONDS = 10 * 60;
const BROWSER_RATE_LIMIT_COOLDOWN_KEY = "browser-run-rate-limit-until";
const BROWSER_DAILY_LIMIT_MS = 10 * 60 * 1000;
const BROWSER_DAILY_BUDGET_MS = 8 * 60 * 1000;
const BROWSER_RUN_RESERVED_MS = 120 * 1000;
const BROWSER_RUN_MIN_REMAINING_MS = 20 * 1000;
const ESTIMATED_LOGIN_AND_SETUP_MS = 12 * 1000;
const ESTIMATED_POST_AND_VERIFY_MS = 2500;
const BROWSER_RUN_LOCK_KEY = "browser-run-active-lock";
const BROWSER_RUN_LOCK_TTL_SECONDS = 2 * 60;
const MONEY_FORWARD_POST_DELAY_MS = 500;
const OPERATION_LOG_LIMIT = 100;

const app = new Hono();

app.use("*", async (c, next) => {
  if (!isAuthorized(c.req.raw, c.env)) {
    return c.text("Forbidden", 403, {
      "www-authenticate": 'Bearer realm="suica-mf-forwarder"'
    });
  }
  await next();
});

app.get("/", (c) => c.html(renderUploadPage()));

app.get("/log", async (c) => c.html(renderLogPage(await readOperationLogs(c.env))));

app.get("/log.json", async (c) => c.json({ logs: await readOperationLogs(c.env) }));

app.post("/upload", async (c) => {
  const env = c.env;
  try {
    const startedAt = performance.now();
    const form = await c.req.formData();
    const file = form.get("pdf");
    if (!(file instanceof File)) {
      return c.json({ error: "pdf file is required" }, 400);
    }
    if (file.type && file.type !== "application/pdf") {
      return c.json({ error: "file must be a PDF" }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const objectKey = buildPdfObjectKey(file.name);

    if (env.SUICA_PDF_BUCKET) {
      await env.SUICA_PDF_BUCKET.put(objectKey, bytes, {
        httpMetadata: { contentType: "application/pdf" }
      });
    }

    const parsed = await parseSuicaPdfBytes(bytes, {
      sourceName: objectKey,
      ...buildParserOptions(env)
    });
    const durationMs = Math.round(performance.now() - startedAt);
    const summary = summarizeParsedPdf(parsed);
    const validation = validateParsedPdf(parsed);
    if (!validation.ok) {
      await appendOperationLog(env, {
        type: "upload_invalid",
        fileName: file.name,
        durationMs,
        issues: validation.issues,
        summary
      });
      return c.json({
        error: "invalid_suica_pdf",
        message: "Suica PDF validation failed",
        durationMs,
        issues: validation.issues,
        summary
      }, 422);
    }

    await appendOperationLog(env, {
      type: "upload_parsed",
      fileName: file.name,
      durationMs,
      summary
    });

    return c.json({
      objectKey,
      durationMs,
      summary,
      parsed
    });
  } catch (error) {
    await appendOperationLog(env, {
      type: "upload_failed",
      message: error instanceof Error ? error.message : String(error)
    });
    return c.json({
      error: "parse_failed",
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

app.post("/post", async (c) => {
  const env = c.env;
  try {
    const payload = await c.req.json();
    const validation = validatePostRequestPayload(payload);
    if (!validation.ok) {
      await appendOperationLog(env, {
        type: "post_rejected",
        reason: "invalid_post_request",
        issues: validation.issues
      });
      return c.json({
        error: "invalid_post_request",
        issues: validation.issues
      }, 400);
    }

    if (!env.MF_EMAIL || !env.MF_PASSWORD) {
      await appendOperationLog(env, {
        type: "post_rejected",
        reason: "missing_money_forward_credentials"
      });
      return c.json({
        error: "missing_money_forward_credentials",
        message: "MF_EMAIL and MF_PASSWORD secrets are required"
      }, 500);
    }

    if (!env.MF_SUICA_ACCOUNT_DETAIL_URL && !env.MF_MANUAL_EXPENSE_URL) {
      await appendOperationLog(env, {
        type: "post_rejected",
        reason: "missing_money_forward_account_url"
      });
      return c.json({
        error: "missing_money_forward_account_url",
        message: "MF_SUICA_ACCOUNT_DETAIL_URL or MF_MANUAL_EXPENSE_URL is required"
      }, 500);
    }

    const cooldown = await getBrowserRunCooldown(env);
    if (cooldown.active) {
      await appendOperationLog(env, {
        type: "post_rejected",
        reason: "browser_run_rate_limited_cooldown",
        retryAfterSeconds: cooldown.retryAfterSeconds
      });
      return c.json({
        error: "browser_run_rate_limited",
        message: "Cloudflare Browser Run is cooling down after a rate limit. Try again later.",
        retryAfterSeconds: cooldown.retryAfterSeconds
      }, 429, {
        "retry-after": String(cooldown.retryAfterSeconds)
      });
    }

    const usage = await getBrowserRunUsage(env);
    if (usage.remainingBudgetMs < BROWSER_RUN_MIN_REMAINING_MS) {
      await appendOperationLog(env, {
        type: "post_rejected",
        reason: "browser_run_daily_budget_exhausted",
        usage
      });
      return c.json({
        error: "browser_run_daily_budget_exhausted",
        message: "Daily Browser Run budget is exhausted. This worker stops before Cloudflare's 10 minute limit.",
        usage
      }, 429);
    }

    const lock = await acquireBrowserRunLock(env);
    if (!lock.acquired) {
      await appendOperationLog(env, {
        type: "post_rejected",
        reason: "browser_run_already_active",
        retryAfterSeconds: BROWSER_RUN_LOCK_TTL_SECONDS
      });
      return c.json({
        error: "browser_run_already_active",
        message: "A Money Forward posting run is already active. Concurrent Browser Run sessions are blocked.",
        retryAfterSeconds: BROWSER_RUN_LOCK_TTL_SECONDS
      }, 409, {
        "retry-after": String(BROWSER_RUN_LOCK_TTL_SECONDS)
      });
    }

    return await runMoneyForwardPosting(c, payload, validation, usage, lock);
  } catch (error) {
    if (isBrowserRunRateLimitError(error)) {
      await setBrowserRunCooldown(env);
      await appendOperationLog(env, {
        type: "post_failed",
        reason: "browser_run_rate_limited",
        message: error instanceof Error ? error.message : String(error),
        retryAfterSeconds: BROWSER_RATE_LIMIT_COOLDOWN_SECONDS
      });
      return c.json({
        error: "browser_run_rate_limited",
        message: "Cloudflare Browser Run rate limit exceeded. No Money Forward entry was created by this request.",
        retryAfterSeconds: BROWSER_RATE_LIMIT_COOLDOWN_SECONDS
      }, 429, {
        "retry-after": String(BROWSER_RATE_LIMIT_COOLDOWN_SECONDS)
      });
    }

    await appendOperationLog(env, {
      type: "post_failed",
      reason: "post_failed",
      message: error instanceof Error ? error.message : String(error)
    });
    return c.json({
      error: "post_failed",
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

app.notFound((c) => c.text("Not found", 404));

export default app;

async function runMoneyForwardPosting(c, payload, validation, usage, lock) {
  const env = c.env;
  const browserRunStartedAt = Date.now();
  const puppeteer = await import("@cloudflare/puppeteer");
  let session;
  let usageRecorded = false;
  await appendOperationLog(env, {
    type: "post_started",
    readyExpenseRows: validation.readyExpenseRows,
    usage,
    policy: buildBrowserPolicy()
  });
  const maxPostRows = computeMaxPostRowsForRun(validation.readyExpenseRows, usage);

  try {
    session = await createCloudflareBrowserPage(env, puppeteer, {
      keepAliveMs: BROWSER_RUN_RESERVED_MS
    });
    const result = await postReadyRowsToMoneyForward(session.page, payload.transactions, {
      dryRun: false,
      maxPostRows,
      maxPostRowsStopReason: "run_time_budget",
      verifyBalanceEveryRows: BALANCE_RECONCILIATION_INTERVAL_ROWS,
      verifyBalanceAfterFirstPost: true,
      stopBeforeElapsedMs: BROWSER_RUN_RESERVED_MS,
      postDelayMs: MONEY_FORWARD_POST_DELAY_MS,
      credentials: {
        email: env.MF_EMAIL,
        password: env.MF_PASSWORD
      },
      suicaAccountDetailUrl: env.MF_SUICA_ACCOUNT_DETAIL_URL || env.MF_MANUAL_EXPENSE_URL,
      manualExpenseUrl: env.MF_MANUAL_EXPENSE_URL || env.MF_SUICA_ACCOUNT_DETAIL_URL,
      suicaAccountName: env.MF_SUICA_ACCOUNT_NAME || "SUICA",
      env,
      stopOnUnknown: true
    });
    await session.close();
    session = null;
    usageRecorded = true;
    const browserRunUsage = await addBrowserRunUsage(env, Date.now() - browserRunStartedAt);
    const summary = summarizePostResult(result, { browserRunUsage });
    await appendOperationLog(env, {
      type: "post_finished",
      summary
    });

    return c.json({
      summary,
      result
    });
  } finally {
    if (session) {
      await session.close();
    }
    if (!usageRecorded) {
      await addBrowserRunUsage(env, Date.now() - browserRunStartedAt);
    }
    await releaseBrowserRunLock(env, lock.token);
  }
}

export function buildParserOptions(env) {
  return {
    lastPostedFingerprint: env.LAST_POSTED_FINGERPRINT || undefined,
    lastEnteredDate: env.LAST_ENTERED_DATE || undefined,
    lastEnteredAmount: env.LAST_ENTERED_AMOUNT || undefined,
    lastEnteredBalanceAfter: env.LAST_ENTERED_BALANCE_AFTER || undefined
  };
}

export function isAuthorized(request, env) {
  const accessEmail = request.headers.get("cf-access-authenticated-user-email");
  if (env.ACCESS_ALLOWED_EMAIL && accessEmail) {
    return timingSafeEqualString(accessEmail.toLowerCase(), env.ACCESS_ALLOWED_EMAIL.toLowerCase());
  }

  const expected = env.UPLOAD_AUTH_TOKEN;
  if (!expected) return false;

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer && timingSafeEqualString(bearer, expected)) return true;

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  return Boolean(token && timingSafeEqualString(token, expected));
}

export function summarizeParsedPdf(parsed) {
  const statuses = {};
  const kinds = {};
  for (const row of parsed.transactions) {
    statuses[row.status] = (statuses[row.status] ?? 0) + 1;
    kinds[row.mfKind] = (kinds[row.mfKind] ?? 0) + 1;
  }

  return {
    cardSuffix: parsed.cardSuffix,
    reportDate: parsed.reportDate,
    rowCount: parsed.transactions.length,
    rowCountLabel: parsed.rowCountLabel,
    statuses,
    kinds,
    invalidBalanceRows: parsed.transactions.filter((row) => row.balanceChainValid === false).length,
    readyRows: parsed.transactions.filter((row) => row.status === "ready").length
  };
}

export function validateParsedPdf(parsed) {
  const issues = [];

  if (parsed.source !== "mobile-suica") issues.push("source is not mobile-suica");
  if (!parsed.cardSuffix) issues.push("card suffix was not found");
  if (!parsed.reportDate) issues.push("report date was not found");
  if (!parsed.rowCountLabel) issues.push("row count label was not found");
  if (parsed.transactions.length === 0) issues.push("no Suica rows were parsed");
  if (parsed.rowCountLabel && parsed.rowCountLabel !== parsed.transactions.length) {
    issues.push(`row count mismatch: label=${parsed.rowCountLabel} parsed=${parsed.transactions.length}`);
  }

  const invalidBalanceRows = parsed.transactions.filter((row) => row.balanceChainValid === false);
  if (invalidBalanceRows.length > 0) {
    issues.push(`balance chain mismatch: ${invalidBalanceRows.length} row(s)`);
  }

  const missingFingerprints = parsed.transactions.filter((row) => !row.fingerprint);
  if (missingFingerprints.length > 0) {
    issues.push(`missing fingerprints: ${missingFingerprints.length} row(s)`);
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

export function validatePostRequestPayload(payload) {
  const issues = [];
  if (payload?.confirm !== "post-ready-rows") {
    issues.push("confirmation token is required");
  }
  if (!Array.isArray(payload?.transactions)) {
    issues.push("transactions array is required");
  }

  const readyExpenseRows = Array.isArray(payload?.transactions)
    ? payload.transactions.filter((row) => row.status === "ready" && row.signedAmount < 0)
    : [];
  if (Array.isArray(payload?.transactions) && readyExpenseRows.length === 0) {
    issues.push("no ready expense rows to post");
  }

  return {
    ok: issues.length === 0,
    issues,
    readyExpenseRows: readyExpenseRows.length
  };
}

export function summarizePostResult(result, options = {}) {
  const statuses = {};
  for (const row of result.results ?? []) {
    statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  }

  const summary = {
    mode: result.mode,
    total: result.results?.length ?? 0,
    postedAttemptCount: result.postedAttemptCount ?? 0,
    currentBalance: result.currentBalance ?? null,
    stoppedReason: result.stoppedReason ?? null,
    partial: Boolean(result.partial),
    resourcePolicy: result.resourcePolicy,
    statuses
  };
  if (options.browserRunUsage) summary.browserRunUsage = options.browserRunUsage;
  return summary;
}

async function getBrowserRunUsage(env) {
  if (!env.SUICA_MF_KV) {
    return buildBrowserUsage(0);
  }
  const key = getBrowserRunUsageKey();
  const usedMs = Number(await env.SUICA_MF_KV.get(key)) || 0;
  return buildBrowserUsage(usedMs);
}

async function addBrowserRunUsage(env, elapsedMs) {
  if (!env.SUICA_MF_KV || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return getBrowserRunUsage(env);
  }
  const key = getBrowserRunUsageKey();
  const current = Number(await env.SUICA_MF_KV.get(key)) || 0;
  const next = current + Math.ceil(elapsedMs);
  await env.SUICA_MF_KV.put(key, String(next), { expirationTtl: 36 * 60 * 60 });
  return buildBrowserUsage(next);
}

function buildBrowserUsage(usedMs) {
  return {
    dateKey: getBrowserRunDateKey(),
    usedMs,
    budgetMs: BROWSER_DAILY_BUDGET_MS,
    cloudflareLimitMs: BROWSER_DAILY_LIMIT_MS,
    remainingBudgetMs: Math.max(0, BROWSER_DAILY_BUDGET_MS - usedMs),
    reserveMs: BROWSER_DAILY_LIMIT_MS - BROWSER_DAILY_BUDGET_MS,
    perRunReservedMs: BROWSER_RUN_RESERVED_MS
  };
}

function buildBrowserPolicy() {
  return {
    dailyLimitMs: BROWSER_DAILY_LIMIT_MS,
    dailyBudgetMs: BROWSER_DAILY_BUDGET_MS,
    reserveMs: BROWSER_DAILY_LIMIT_MS - BROWSER_DAILY_BUDGET_MS,
    perRunReservedMs: BROWSER_RUN_RESERVED_MS,
    minRemainingMs: BROWSER_RUN_MIN_REMAINING_MS,
    estimatedLoginAndSetupMs: ESTIMATED_LOGIN_AND_SETUP_MS,
    estimatedPostAndVerifyMs: ESTIMATED_POST_AND_VERIFY_MS,
    balanceReconciliation: "enabled",
    postDelayMs: MONEY_FORWARD_POST_DELAY_MS,
    concurrentRuns: 1
  };
}

function computeMaxPostRowsForRun(readyExpenseRows, usage) {
  const availableMs = Math.min(BROWSER_RUN_RESERVED_MS, usage.remainingBudgetMs);
  const postingBudgetMs = Math.max(0, availableMs - ESTIMATED_LOGIN_AND_SETUP_MS);
  const estimatedRows = Math.floor(postingBudgetMs / ESTIMATED_POST_AND_VERIFY_MS);
  return Math.max(1, Math.min(readyExpenseRows, estimatedRows));
}

async function appendOperationLog(env, entry) {
  if (!env.SUICA_MF_KV) return;
  try {
    const key = getOperationLogKey();
    const logs = await readOperationLogs(env);
    logs.push({
      at: new Date().toISOString(),
      ...entry
    });
    const trimmed = logs.slice(-OPERATION_LOG_LIMIT);
    await env.SUICA_MF_KV.put(key, JSON.stringify(trimmed), { expirationTtl: 14 * 24 * 60 * 60 });
  } catch {
    // Logging must not block upload or Money Forward posting.
  }
}

async function readOperationLogs(env) {
  if (!env.SUICA_MF_KV) return [];
  try {
    const text = await env.SUICA_MF_KV.get(getOperationLogKey());
    const logs = text ? JSON.parse(text) : [];
    return Array.isArray(logs) ? logs : [];
  } catch {
    return [];
  }
}

function getOperationLogKey() {
  return `operation-log:${getBrowserRunDateKey()}`;
}

async function acquireBrowserRunLock(env) {
  if (!env.SUICA_MF_KV) return { acquired: true, token: "" };
  const existing = await env.SUICA_MF_KV.get(BROWSER_RUN_LOCK_KEY);
  if (existing) return { acquired: false, token: "" };
  const token = crypto.randomUUID();
  await env.SUICA_MF_KV.put(BROWSER_RUN_LOCK_KEY, token, { expirationTtl: BROWSER_RUN_LOCK_TTL_SECONDS });
  return { acquired: true, token };
}

async function releaseBrowserRunLock(env, token) {
  if (!env.SUICA_MF_KV || !token) return;
  const current = await env.SUICA_MF_KV.get(BROWSER_RUN_LOCK_KEY);
  if (current === token) {
    await env.SUICA_MF_KV.delete(BROWSER_RUN_LOCK_KEY);
  }
}

function getBrowserRunUsageKey() {
  return `browser-run-usage:${getBrowserRunDateKey()}`;
}

function getBrowserRunDateKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getBrowserRunCooldown(env) {
  if (!env.SUICA_MF_KV) return { active: false, retryAfterSeconds: 0 };
  const untilText = await env.SUICA_MF_KV.get(BROWSER_RATE_LIMIT_COOLDOWN_KEY);
  const until = Number(untilText);
  const now = Date.now();
  if (!Number.isFinite(until) || until <= now) {
    return { active: false, retryAfterSeconds: 0 };
  }

  return {
    active: true,
    retryAfterSeconds: Math.ceil((until - now) / 1000)
  };
}

async function setBrowserRunCooldown(env) {
  if (!env.SUICA_MF_KV) return;
  const until = Date.now() + BROWSER_RATE_LIMIT_COOLDOWN_SECONDS * 1000;
  await env.SUICA_MF_KV.put(BROWSER_RATE_LIMIT_COOLDOWN_KEY, String(until), {
    expirationTtl: BROWSER_RATE_LIMIT_COOLDOWN_SECONDS
  });
}

function isBrowserRunRateLimitError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message) || /rate limit/i.test(message);
}

function buildPdfObjectKey(fileName) {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  return `uploads/${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName}`;
}

function renderUploadPage() {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Suica PDF Upload</title>
  <style>
    :root {
      --color-paper: #fdfdfd;
      --color-surface: rgba(255, 255, 255, 0.72);
      --color-surface-soft: #f6f7f8;
      --color-border: rgba(31, 35, 38, 0.1);
      --color-border-strong: rgba(31, 35, 38, 0.18);
      --color-text: #1f2225;
      --color-muted: #737a80;
      --color-accent: #687f93;
      --color-accent-hover: #536d83;
      --color-on-accent: #fff;
      --shadow-hairline: 0 1px 0 rgba(28, 31, 33, 0.04);
      --shadow-float: 0 20px 70px rgba(26, 30, 34, 0.07);
      --font-sans: ui-sans-serif, system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Segoe UI", sans-serif;
      --font-mono: "Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, Monaco, monospace;
      color: var(--color-text);
      background: var(--color-paper);
      font-family: var(--font-sans);
      font-size: 14px;
      letter-spacing: 0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      min-height: 100vh;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(246, 247, 248, 0.82)), var(--color-paper);
    }
    main { width: min(1040px, calc(100% - 32px)); margin: 0 auto; padding: 42px 0; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 22px; font-weight: 520; line-height: 1.32; }
    a { color: var(--color-accent); text-decoration: none; font-weight: 700; }
    form, #status, .metric {
      border: 1px solid var(--color-border);
      border-radius: 10px;
      background: var(--color-surface);
      box-shadow: var(--shadow-hairline);
      backdrop-filter: blur(18px);
    }
    form { margin-top: 26px; padding: 24px; display: grid; gap: 16px; }
    label { display: grid; gap: 6px; font-size: 13px; color: var(--color-muted); }
    input { font: inherit; padding: 10px 12px; border: 1px solid var(--color-border-strong); border-radius: 8px; background: white; }
    button {
      width: fit-content;
      min-height: 32px;
      padding: 6px 14px;
      border: 0;
      border-radius: 999px;
      background: var(--color-accent);
      color: var(--color-on-accent);
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 10px 26px rgba(104, 127, 147, 0.16);
    }
    button:hover:not(:disabled) { background: var(--color-accent-hover); }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
    .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    #post-button { display: none; }
    #status { margin: 16px 0; padding: 12px 14px; color: var(--color-muted); }
    #status.busy { border-color: rgba(104, 127, 147, 0.38); background: #fff; color: var(--color-accent-hover); box-shadow: var(--shadow-float); }
    #status.ok { border-color: rgba(22, 101, 52, 0.2); background: #f7fbf8; color: #166534; }
    #status.warn { border-color: rgba(146, 64, 14, 0.22); background: #fffaf0; color: #92400e; }
    #status.error { border-color: rgba(153, 27, 27, 0.2); background: #fff6f6; color: #991b1b; }
    #summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; }
    .metric { padding: 12px; }
    .metric span { display: block; color: var(--color-muted); font-size: 12px; margin-bottom: 4px; }
    .metric strong { display: block; font-size: 20px; font-weight: 520; }
    pre { margin-top: 20px; padding: 16px; background: #1f2225; color: #f6f7f8; overflow: auto; border-radius: 10px; font-family: var(--font-mono); font-size: 12px; }
    @media (max-width: 760px) {
      main { width: min(100% - 24px, 1040px); padding: 18px 0; }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Suica PDF Upload</h1>
      <nav><a href="/log">ログを見る</a></nav>
    </header>
    <form id="upload-form">
      <label>PDF<input name="pdf" type="file" accept="application/pdf" required></label>
      <div class="actions">
        <button type="submit">Parse</button>
        <button id="post-button" type="button">MFへ入力する</button>
      </div>
    </form>
    <div id="status">PDFを選択してParseしてください。</div>
    <div id="summary"></div>
    <pre id="result"></pre>
  </main>
  <script>
    const form = document.querySelector("#upload-form");
    const result = document.querySelector("#result");
    const statusBox = document.querySelector("#status");
    const summaryBox = document.querySelector("#summary");
    const submitButton = form.querySelector("button[type=submit]");
    const postButton = document.querySelector("#post-button");
    let lastParsed = null;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setStatus("busy", "PDFを解析しています。");
      summaryBox.innerHTML = "";
      result.textContent = "";
      submitButton.disabled = true;
      postButton.style.display = "none";
      lastParsed = null;
      try {
        const response = await fetch("/upload", { method: "POST", body: new FormData(form) });
        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error("HTTP " + response.status + " returned non-JSON response: " + text.slice(0, 300));
        }
        const payload = json.summary
          ? { status: response.status, durationMs: json.durationMs, summary: json.summary, issues: json.issues }
          : { status: response.status, ...json };
        result.textContent = JSON.stringify(payload, null, 2);
        if (response.ok && json.parsed && json.summary?.readyRows > 0) {
          lastParsed = json.parsed;
          postButton.textContent = "MFへ入力する (" + json.summary.readyRows + "件 / 残高照合あり)";
          postButton.style.display = "inline-flex";
          setStatus("ok", "解析完了。MF入力前に件数と残高エラー数を確認してください。");
          renderMetrics([
            ["未入力候補", json.summary.readyRows + "件"],
            ["PDF明細", json.summary.rowCount + "件"],
            ["残高エラー", json.summary.invalidBalanceRows + "件"],
            ["解析時間", json.durationMs + "ms"]
          ]);
        } else if (response.ok) {
          setStatus("ok", "解析完了。MFへ入力する未入力候補はありません。");
          renderMetrics([
            ["未入力候補", (json.summary?.readyRows ?? 0) + "件"],
            ["PDF明細", (json.summary?.rowCount ?? 0) + "件"],
            ["解析時間", (json.durationMs ?? 0) + "ms"]
          ]);
        } else {
          setStatus("error", "PDF検証に失敗しました。詳細JSONと /log を確認してください。");
        }
      } catch (error) {
        setStatus("error", "解析でエラーが発生しました。");
        result.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        submitButton.disabled = false;
      }
    });

    postButton.addEventListener("click", async () => {
      if (!lastParsed) return;
      const readyRows = lastParsed.transactions.filter((row) => row.status === "ready" && row.signedAmount < 0).length;
      const ok = confirm("Money Forwardに" + readyRows + "件を作成します。実行しますか？");
      if (!ok) return;

      postButton.disabled = true;
      submitButton.disabled = true;
      const batches = [];
      const logs = [];
      const renderLog = () => {
        result.textContent = JSON.stringify({ logs, batches }, null, 2);
      };
      setStatus("busy", "Money Forwardへ入力しています。ブラウザは1セッションだけ使い、途中で残高を照合します。");
      summaryBox.innerHTML = "";
      logs.push({
        at: new Date().toISOString(),
        message: "Money Forward posting started",
        readyRows,
        note: "This run uses one Browser Run session and reconciles the balance during posting."
      });
      renderLog();
      try {
        logs.push({
          at: new Date().toISOString(),
          message: "Batch started",
          batchNumber: 1
        });
        renderLog();
        const response = await fetch("/post", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirm: "post-ready-rows",
            transactions: lastParsed.transactions
          })
        });
        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error("HTTP " + response.status + " returned non-JSON response: " + text.slice(0, 300));
        }
        const batch = { status: response.status, ...json };
        batches.push(batch);
        const summary = json.summary ?? {};
        renderMetrics([
          ["投入試行", (summary.postedAttemptCount ?? 0) + "件"],
          ["現在残高", summary.currentBalance == null ? "-" : summary.currentBalance + "円"],
          ["停止理由", summary.stoppedReason ?? (response.ok ? "完了" : json.error ?? "エラー")],
          ["残予算", summary.browserRunUsage?.remainingBudgetMs == null ? "-" : Math.floor(summary.browserRunUsage.remainingBudgetMs / 1000) + "秒"]
        ]);
        logs.push({
          at: new Date().toISOString(),
          message: "Batch finished",
          batchNumber: 1,
          httpStatus: response.status,
          summary: json.summary,
          retryAfterSeconds: json.retryAfterSeconds,
          results: summarizeBrowserResults(json.result?.results)
        });
        logs.push({
          at: new Date().toISOString(),
          message: "Posting stopped",
          batchNumber: 1,
          reason: response.ok ? (json.summary?.stoppedReason ?? "single_batch_complete") : json.error ?? "http_error"
        });
        renderLog();
        if (response.ok && !json.summary?.stoppedReason) {
          setStatus("ok", "MF入力が完了しました。必要ならMF画面で残高を確認してください。");
        } else if (response.ok) {
          setStatus("warn", "MF入力は途中で停止しました。停止理由を確認してください。");
        } else if (response.status === 429) {
          setStatus("warn", "Browser Run制限で停止しました。再試行まで待ってください。");
        } else {
          setStatus("error", "MF入力でエラーが発生しました。詳細JSONと /log を確認してください。");
        }
      } catch (error) {
        setStatus("error", "MF入力でエラーが発生しました。");
        logs.push({
          at: new Date().toISOString(),
          message: "Posting error",
          error: error instanceof Error ? error.message : String(error)
        });
        renderLog();
      } finally {
        postButton.disabled = false;
        submitButton.disabled = false;
      }
    });

    function setStatus(kind, text) {
      statusBox.className = kind;
      statusBox.textContent = text;
    }

    function renderMetrics(items) {
      summaryBox.innerHTML = items.map(([label, value]) =>
        '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(String(value)) + '</strong></div>'
      ).join("");
    }

    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function summarizeBrowserResults(rows) {
      if (!Array.isArray(rows)) return [];
      return rows.map((row) => ({
        status: row.status,
        date: row.expense?.date,
        amount: row.expense?.amount,
        balanceAfter: row.expense?.balanceAfter,
        content: row.expense?.content,
        error: row.error
      }));
    }
  </script>
</body>
</html>`;
}

function renderLogPage(logs) {
  const rows = logs.slice().reverse().map((entry) => {
    const summary = entry.summary ?? {};
    const detail = JSON.stringify(entry, null, 2);
    return `<tr>
      <td>${escapeHtml(entry.at ?? "")}</td>
      <td>${escapeHtml(entry.type ?? "")}</td>
      <td>${escapeHtml(entry.reason ?? summary.stoppedReason ?? "")}</td>
      <td>${escapeHtml(String(summary.postedAttemptCount ?? entry.readyExpenseRows ?? ""))}</td>
      <td class="detail-cell"><details><summary>JSON</summary><pre>${escapeHtml(detail)}</pre></details></td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Suica MF Logs</title>
  <style>
    :root {
      --color-paper: #fdfdfd;
      --color-surface: rgba(255, 255, 255, 0.72);
      --color-border: rgba(31, 35, 38, 0.1);
      --color-text: #1f2225;
      --color-muted: #737a80;
      --color-accent: #687f93;
      --font-sans: ui-sans-serif, system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Segoe UI", sans-serif;
      --font-mono: "Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, Monaco, monospace;
      color: var(--color-text);
      background: var(--color-paper);
      font-family: var(--font-sans);
      font-size: 14px;
      letter-spacing: 0;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; min-height: 100vh; background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(246, 247, 248, 0.82)), var(--color-paper); }
    main { width: min(1100px, calc(100% - 32px)); margin: 0 auto; padding: 42px 0; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 22px; font-weight: 520; line-height: 1.32; }
    a { color: var(--color-accent); text-decoration: none; font-weight: 700; }
    .table-wrap { width: 100%; margin-top: 26px; overflow-x: auto; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-surface); backdrop-filter: blur(18px); }
    table { width: 100%; min-width: 900px; table-layout: fixed; border-collapse: collapse; }
    col.time { width: 210px; }
    col.type { width: 170px; }
    col.reason { width: 230px; }
    col.count { width: 72px; }
    col.detail { width: auto; }
    th, td { padding: 9px 12px; border-bottom: 1px solid var(--color-border); text-align: left; vertical-align: top; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; line-height: 1.54; }
    th { background: rgba(246, 247, 248, 0.7); color: var(--color-muted); font-size: 12px; font-weight: 520; }
    tbody tr:hover td { background: rgba(247, 248, 248, 0.62); }
    .detail-cell { overflow: visible; text-overflow: clip; }
    details { max-width: 100%; }
    summary { cursor: pointer; color: var(--color-accent); font-weight: 700; }
    pre { white-space: pre; overflow: auto; width: min(100%, 520px); max-height: 360px; background: #1f2225; color: #f6f7f8; padding: 12px; border-radius: 10px; font-family: var(--font-mono); font-size: 12px; }
    @media (max-width: 760px) {
      main { width: min(100% - 24px, 1100px); padding: 18px 0; }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Suica MF Logs</h1>
      <nav><a href="/">アップロードへ戻る</a> <a href="/log.json">JSON</a></nav>
    </header>
    <div class="table-wrap">
      <table>
        <colgroup>
          <col class="time">
          <col class="type">
          <col class="reason">
          <col class="count">
          <col class="detail">
        </colgroup>
        <thead><tr><th>時刻</th><th>種別</th><th>理由</th><th>件数</th><th>詳細</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">ログはまだありません。</td></tr>'}</tbody>
      </table>
    </div>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function timingSafeEqualString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}
