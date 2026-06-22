import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMoneyForwardExpense,
  buildPostingPlan,
  createCloudflareBrowserPage,
  loginToMoneyForward,
  pollForVerificationCode,
  postReadyRowsToMoneyForward
} from "../src/money-forward-browser-run.mjs";

const readyTransportRow = {
  status: "ready",
  mfKind: "expense_transport",
  transactionDate: "2026-06-06",
  signedAmount: -209,
  amountAbs: 209,
  balanceAfter: 13496,
  mfContent: "Suica 地 駅A -> 駅B",
  fingerprint: "a".repeat(64),
  rawLine: "06 06 定 地 駅A 出 駅B \\13,496 -209"
};

const chargeRow = {
  status: "needs_review",
  mfKind: "charge",
  transactionDate: "2026-06-01",
  signedAmount: 15000,
  amountAbs: 15000,
  fingerprint: "b".repeat(64)
};

const TEST_MF_CONFIG = {
  suicaAccountDetailUrl: "https://example.test/accounts/show_manual/suica",
  manualExpenseUrl: "https://example.test/accounts/show_manual/suica"
};

test("builds a Money Forward expense from a ready Suica spending row", () => {
  const expense = buildMoneyForwardExpense(readyTransportRow);

  assert.equal(expense.date, "2026-06-06");
  assert.equal(expense.amount, 209);
  assert.equal(expense.balanceAfter, 13496);
  assert.equal(expense.account, "SUICA");
  assert.equal(expense.category, "交通費");
  assert.equal(expense.subCategory, "電車");
  assert.equal(expense.largeCategoryId, "20");
  assert.equal(expense.middleCategoryId, "96");
  assert.equal(expense.memo, `suica-fingerprint:${"a".repeat(64)}`);
});

test("does not build posting payloads for charge or non-ready rows", () => {
  assert.equal(buildMoneyForwardExpense(chargeRow), null);
  assert.deepEqual(buildPostingPlan([readyTransportRow, chargeRow]).map((expense) => expense.fingerprint), [
    readyTransportRow.fingerprint
  ]);
});

test("dry-run returns the posting plan without touching the browser page", async () => {
  const page = makeFakePage();
  const result = await postReadyRowsToMoneyForward(page, [readyTransportRow, chargeRow]);

  assert.equal(result.mode, "dry_run");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, "ready");
  assert.deepEqual(page.calls, []);
});

test("posts ready rows and reports posted after confirmation", async () => {
  const page = makeFakePage();
  const result = await postReadyRowsToMoneyForward(page, [readyTransportRow], {
    ...TEST_MF_CONFIG,
    dryRun: false,
    postDelayMs: 0,
    balanceVerifyIntervalMs: 0
  });

  assert.equal(result.mode, "browser_run");
  assert.equal(result.results[0].status, "posted");
  assert.ok(page.calls.some((call) => call[0] === "goto"));
  assert.ok(page.calls.some((call) => call[0] === "waitForSelector" && call[1] === "#appendedPrependedInput"));
  assert.ok(page.calls.some((call) => call[0] === "type" && call[2] === "209"));
  assert.ok(page.calls.some((call) => call[0] === "$eval" && call[1] === "#updated-at" && call[2] === "2026/06/06"));
  assert.ok(page.calls.some((call) => call[0] === "evaluate" && call[1] === "#user_asset_act_sub_account_id_hash" && call[2] === "SUICA"));
  assert.ok(page.calls.some((call) => call[0] === "$eval" && call[1] === "#user_asset_act_large_category_id" && call[2] === "20"));
  assert.ok(page.calls.some((call) => call[0] === "$eval" && call[1] === "#user_asset_act_middle_category_id" && call[2] === "96"));
  assert.ok(page.calls.some((call) => call[0] === "waitForSelector" && call[1] === "#submit-button"));
});

test("marks a batch unknown if the final balance check does not match", async () => {
  const page = makeFakePage({ noBalanceAfterSubmit: true });
  const result = await postReadyRowsToMoneyForward(page, [readyTransportRow], {
    ...TEST_MF_CONFIG,
    dryRun: false,
    postDelayMs: 0,
    balanceVerifyIntervalMs: 0
  });

  assert.equal(result.stoppedReason, "balance_mismatch");
  assert.equal(result.results[0].status, "posted");
  assert.equal(result.results[1].status, "unknown");
});

test("skips rows already covered by the current Money Forward balance", async () => {
  const page = makeFakePage({ currentBalance: 12848 });
  const result = await postReadyRowsToMoneyForward(page, [readyTransportRow], {
    ...TEST_MF_CONFIG,
    dryRun: false,
    postDelayMs: 0,
    balanceVerifyIntervalMs: 0
  });

  assert.equal(result.results[0].status, "skipped_balance");
  assert.ok(!page.calls.some((call) => call[0] === "waitForSelector" && call[1] === "#submit-button"));
});

test("stops immediately on a pre-submit form failure", async () => {
  const rows = [
    { ...readyTransportRow, fingerprint: "1".repeat(64), balanceAfter: 13496 },
    { ...readyTransportRow, fingerprint: "2".repeat(64), balanceAfter: 13287 }
  ];
  const page = makeFakePage({ formDataValues: ["2026/07/08"] });
  const result = await postReadyRowsToMoneyForward(page, rows, {
    ...TEST_MF_CONFIG,
    dryRun: false,
    postDelayMs: 0,
    balanceVerifyIntervalMs: 0
  });

  assert.equal(result.stoppedReason, "failed");
  assert.equal(result.postedAttemptCount, 0);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error, /date payload mismatch/);
}
);

test("treats submitted rows as posted when the batch balance matches", async () => {
  const page = makeFakePage({ currentBalanceAfterSubmit: 13496 });
  const result = await postReadyRowsToMoneyForward(page, [readyTransportRow], {
    ...TEST_MF_CONFIG,
    dryRun: false,
    postDelayMs: 0,
    balanceVerifyIntervalMs: 0
  });

  assert.equal(result.results[0].status, "posted");
  assert.equal(result.currentBalance, 13496);
});

test("limits posted rows per browser run batch", async () => {
  const rows = [
    { ...readyTransportRow, fingerprint: "1".repeat(64), balanceAfter: 13496 },
    { ...readyTransportRow, fingerprint: "2".repeat(64), balanceAfter: 13287 },
    { ...readyTransportRow, fingerprint: "3".repeat(64), balanceAfter: 13078 },
    { ...readyTransportRow, fingerprint: "4".repeat(64), balanceAfter: 12848 }
  ];
  const page = makeFakePage({ postedBalances: [13496, 13287, 13078] });
  const result = await postReadyRowsToMoneyForward(page, rows, {
    ...TEST_MF_CONFIG,
    dryRun: false,
    maxPostRows: 3,
    postDelayMs: 0,
    balanceVerifyIntervalMs: 0,
    balancePollIntervalMs: 0
  });

  assert.equal(result.postedAttemptCount, 3);
  assert.equal(result.partial, true);
  assert.equal(result.stoppedReason, "max_post_rows");
  assert.equal(result.currentBalance, 13078);
  assert.equal(result.results.filter((row) => row.status === "posted").length, 3);
});

test("continues in one browser session and reconciles after the first post and at the end", async () => {
  const rows = [
    { ...readyTransportRow, fingerprint: "1".repeat(64), balanceAfter: 13496 },
    { ...readyTransportRow, fingerprint: "2".repeat(64), balanceAfter: 13287 },
    { ...readyTransportRow, fingerprint: "3".repeat(64), balanceAfter: 13078 },
    { ...readyTransportRow, fingerprint: "4".repeat(64), balanceAfter: 12848 }
  ];
  const page = makeFakePage({ postedBalances: [13496, 13287, 13078, 12848] });
  const result = await postReadyRowsToMoneyForward(page, rows, {
    ...TEST_MF_CONFIG,
    dryRun: false,
    postDelayMs: 0,
    balanceVerifyIntervalMs: 0,
    verifyBalanceEveryRows: 5,
    verifyBalanceAfterFirstPost: true
  });

  assert.equal(result.postedAttemptCount, 4);
  assert.equal(result.partial, false);
  assert.equal(result.stoppedReason, null);
  assert.equal(result.currentBalance, 12848);
  assert.equal(result.results.filter((row) => row.status === "posted").length, 4);
  assert.equal(page.calls.filter((call) => call[0] === "evaluate" && call.length === 1).length, 3);
  assert.equal(result.resourcePolicy.balanceReconciliation, "enabled");
});

test("logs into Money Forward and submits an OTP from KV when requested", async () => {
  const page = makeFakePage({ needsOtp: true });
  const env = makeFakeEnv("123456", { emptyReadsBeforeCode: 1 });

  const result = await loginToMoneyForward(
    page,
    { email: "me@example.test", password: "secret" },
    { verificationPollIntervalMs: 0 },
    { env }
  );

  assert.equal(result.verificationCodeSubmitted, true);
  assert.equal(env.deletedKey, "suica-mf-vericode");
  assert.ok(page.calls.some((call) => call[0] === "type" && call[2] === "123456"));
  assert.ok(page.calls.some((call) => call[0] === "title"));
});

test("polls verification code from KV and deletes it after use", async () => {
  const page = makeFakePage();
  const env = makeFakeEnv("654321");

  const code = await pollForVerificationCode(env, page, { verificationPollIntervalMs: 0 });

  assert.equal(code, "654321");
  assert.equal(env.deletedKey, "suica-mf-vericode");
});

test("creates a Cloudflare browser page from either Browser binding shape", async () => {
  const calls = [];
  const puppeteer = {
    launch: async (binding, options) => {
      calls.push(["launch", binding, options]);
      return {
        newPage: async () => {
          calls.push(["newPage"]);
          return { id: "page" };
        },
        close: async () => calls.push(["close"])
      };
    }
  };

  const session = await createCloudflareBrowserPage({ browser: { binding: "BROWSER" } }, puppeteer, {
    keepAliveMs: 120000
  });
  assert.deepEqual(session.page, { id: "page" });
  await session.close();
  assert.deepEqual(calls, [
    ["launch", { binding: "BROWSER" }, { keep_alive: 120000 }],
    ["newPage"],
    ["close"]
  ]);
});

function makeFakePage(options = {}) {
  const calls = [];
  let submitClicked = false;
  let submitCount = 0;
  const page = {
    calls,
    keyboard: {
      press: async (key) => calls.push(["keyboard.press", key])
    },
    $: async (selector) => {
      calls.push(["$", selector]);
      if (selector === "#verification_code" && !options.needsOtp) return null;
      return {
        click: async (...args) => calls.push(["element.click", selector, ...args])
      };
    },
    $eval: async (selector, _fn, value) => calls.push(["$eval", selector, value]),
    goto: async (...args) => calls.push(["goto", ...args]),
    type: async (...args) => calls.push(["type", ...args]),
    title: async () => {
      calls.push(["title"]);
      return "Money Forward";
    },
    waitForNavigation: async (...args) => {
      calls.push(["waitForNavigation", ...args]);
      if (options.failConfirmation) throw new Error("navigation timeout");
    },
    waitForSelector: async (selector) => {
      calls.push(["waitForSelector", selector]);
      if (options.failConfirmation && selector.includes("alert-success")) {
        throw new Error("confirmation timeout");
      }
      return {
        click: async (...args) => {
          calls.push(["element.click", selector, ...args]);
          if (selector === "#submit-button") {
            submitClicked = true;
            submitCount += 1;
          }
        }
      };
    },
    evaluate: async (fn, ...args) => {
      if (String(fn).includes("new FormData")) {
        calls.push(["evaluateFormData"]);
        return options.formDataValues
          ? { found: true, values: options.formDataValues }
          : { found: false, values: [] };
      }
      calls.push(["evaluate", ...args]);
      if (args.length === 0) {
        if (!submitClicked) return options.currentBalance ?? null;
        if (options.noBalanceAfterSubmit) return options.currentBalance ?? null;
        if (options.postedBalances) return options.postedBalances[Math.max(0, submitCount - 1)] ?? null;
        return options.currentBalanceAfterSubmit ?? readyTransportRow.balanceAfter;
      }
      return true;
    }
  };
  return page;
}

function makeFakeEnv(code, options = {}) {
  let reads = 0;
  const env = {
    deletedKey: null,
    SUICA_MF_KV: {
      get: async () => {
        reads += 1;
        return reads <= (options.emptyReadsBeforeCode ?? 0) ? null : code;
      },
      delete: async (key) => {
        env.deletedKey = key;
      }
    }
  };
  return env;
}
