import assert from "node:assert/strict";
import { test } from "node:test";
import {
  default as uploadUiWorker,
  buildParserOptions,
  isAuthorized,
  summarizeParsedPdf,
  summarizePostResult,
  validateParsedPdf,
  validatePostRequestPayload
} from "../src/worker-upload-ui.mjs";

test("Hono app rejects unauthorized requests before route handling", async () => {
  const response = await uploadUiWorker.fetch(new Request("https://example.test/"), {});

  assert.equal(response.status, 403);
});

test("Hono app serves operation logs as JSON for an authorized request", async () => {
  const request = new Request("https://example.test/log.json", {
    headers: { "cf-access-authenticated-user-email": "owner@example.test" }
  });
  const response = await uploadUiWorker.fetch(request, {
    ACCESS_ALLOWED_EMAIL: "owner@example.test"
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { logs: [] });
});

test("summarizes parsed Suica PDF results for upload preview", () => {
  const summary = summarizeParsedPdf({
    cardSuffix: "8933",
    reportDate: "2026-06-20",
    rowCountLabel: 2,
    transactions: [
      { status: "before_cutover", mfKind: "expense_transport", balanceChainValid: true },
      { status: "ready", mfKind: "expense_merchandise", balanceChainValid: true }
    ]
  });

  assert.deepEqual(summary, {
    cardSuffix: "8933",
    reportDate: "2026-06-20",
    rowCount: 2,
    rowCountLabel: 2,
    statuses: { before_cutover: 1, ready: 1 },
    kinds: { expense_transport: 1, expense_merchandise: 1 },
    invalidBalanceRows: 0,
    readyRows: 1
  });
});

test("upload UI requires an auth token", () => {
  const request = new Request("https://example.test/");
  assert.equal(isAuthorized(request, {}), false);

  const authorized = new Request("https://example.test/", {
    headers: { authorization: "Bearer secret-token" }
  });
  assert.equal(isAuthorized(authorized, { UPLOAD_AUTH_TOKEN: "secret-token" }), true);

  const queryAuthorized = new Request("https://example.test/?token=secret-token");
  assert.equal(isAuthorized(queryAuthorized, { UPLOAD_AUTH_TOKEN: "secret-token" }), true);
});

test("upload UI accepts Cloudflare Access authenticated user email", () => {
  const request = new Request("https://example.test/", {
    headers: { "cf-access-authenticated-user-email": "owner@example.test" }
  });

  assert.equal(isAuthorized(request, { ACCESS_ALLOWED_EMAIL: "owner@example.test" }), true);
  assert.equal(isAuthorized(request, { ACCESS_ALLOWED_EMAIL: "other@example.com" }), false);
});

test("builds parser options from worker configuration, not upload form fields", () => {
  assert.deepEqual(buildParserOptions({
    LAST_POSTED_FINGERPRINT: "a".repeat(64),
    LAST_ENTERED_DATE: "2026-05-30",
    LAST_ENTERED_AMOUNT: "218",
    LAST_ENTERED_BALANCE_AFTER: "16174"
  }), {
    lastPostedFingerprint: "a".repeat(64),
    lastEnteredDate: "2026-05-30",
    lastEnteredAmount: "218",
    lastEnteredBalanceAfter: "16174"
  });
});

test("validates parsed Suica PDFs before accepting upload", () => {
  assert.deepEqual(validateParsedPdf({
    source: "mobile-suica",
    cardSuffix: "8933",
    reportDate: "2026-06-20",
    rowCountLabel: 1,
    transactions: [
      { fingerprint: "a".repeat(64), balanceChainValid: true }
    ]
  }), { ok: true, issues: [] });

  const invalid = validateParsedPdf({
    source: "mobile-suica",
    cardSuffix: "8933",
    reportDate: "2026-06-20",
    rowCountLabel: 2,
    transactions: [
      { fingerprint: "a".repeat(64), balanceChainValid: true },
      { fingerprint: "b".repeat(64), balanceChainValid: false },
      { fingerprint: "c".repeat(64), balanceChainValid: true }
    ]
  });

  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.includes("row count mismatch")));
  assert.ok(invalid.issues.some((issue) => issue.includes("balance chain mismatch")));
});

test("requires explicit confirmation and ready expense rows before posting to Money Forward", () => {
  const readyExpense = {
    status: "ready",
    signedAmount: -209
  };

  assert.deepEqual(validatePostRequestPayload({
    confirm: "post-ready-rows",
    transactions: [readyExpense]
  }), {
    ok: true,
    issues: [],
    readyExpenseRows: 1
  });

  const invalid = validatePostRequestPayload({
    transactions: [{ status: "ready", signedAmount: 15000 }]
  });

  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.includes("confirmation token is required"));
  assert.ok(invalid.issues.includes("no ready expense rows to post"));
});

test("summarizes Money Forward posting results", () => {
  assert.deepEqual(summarizePostResult({
    mode: "browser_run",
    postedAttemptCount: 3,
    currentBalance: 13078,
    stoppedReason: "max_post_rows",
    partial: true,
    resourcePolicy: {
      browserLaunches: 1,
      pages: 1,
      loginAttempts: 1,
      balanceReconciliation: "enabled"
    },
    results: [
      { status: "posted" },
      { status: "posted" },
      { status: "unknown" }
    ]
  }), {
    mode: "browser_run",
    total: 3,
    postedAttemptCount: 3,
    currentBalance: 13078,
    stoppedReason: "max_post_rows",
    partial: true,
    resourcePolicy: {
      browserLaunches: 1,
      pages: 1,
      loginAttempts: 1,
      balanceReconciliation: "enabled"
    },
    statuses: {
      posted: 2,
      unknown: 1
    }
  });
});
