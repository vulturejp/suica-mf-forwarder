const DEFAULT_MF_CONFIG = {
  baseUrl: "https://ssnb.x.moneyforward.com",
  loginUrl: "https://ssnb.x.moneyforward.com/users/sign_in",
  suicaAccountDetailUrl: null,
  manualExpenseUrl: null,
  suicaAccountName: "SUICA",
  transportCategory: "交通費",
  transportSubCategory: "電車",
  transportLargeCategoryId: "20",
  transportMiddleCategoryId: "96",
  merchandiseCategory: "未分類",
  merchandiseSubCategory: "未分類",
  merchandiseLargeCategoryId: null,
  merchandiseMiddleCategoryId: null,
  memoPrefix: "suica-fingerprint:",
  skipByCurrentBalance: true,
  verificationCodeKey: "suica-mf-vericode",
  verificationPollAttempts: 108,
  verificationPollIntervalMs: 5000,
  postDelayMs: 2000,
  balanceVerifyAttempts: 6,
  balanceVerifyIntervalMs: 1500,
  selectors: {
    emailInput: "#sign_in_session_service_email",
    passwordInput: "#sign_in_session_service_password",
    loginSubmit: "#login-btn-sumit",
    verificationCodeInput: "#verification_code",
    manualEntryButton: '.cf-new-btn[href="#user_asset_act_new"]',
    dateInput: "#updated-at",
    dateHiddenInput: "#js-cf-manual-payment-entry-updated-at",
    dateLabel: "#js-cf-manual-payment-entry-updated-at-label",
    amountInput: "#appendedPrependedInput",
    contentInput: "#js-content-field",
    memoInput: 'textarea[name="memo"], textarea[name="user_asset_act[memo]"]',
    accountSelect: "#user_asset_act_sub_account_id_hash",
    categoryHiddenInput: "#user_asset_act_large_category_id",
    subCategoryHiddenInput: "#user_asset_act_middle_category_id",
    categoryLabel: "#js-large-category-selected",
    subCategoryLabel: "#js-middle-category-selected",
    submitButton: "#submit-button",
    successMessage: ".alert-success, .flash_notice, .notification-success"
  }
};

export function buildMoneyForwardExpense(row, config = {}) {
  const resolved = resolveMoneyForwardConfig(config);

  if (row.status !== "ready") return null;
  if (row.signedAmount == null || row.signedAmount >= 0) return null;

  const isTransport = row.mfKind === "expense_transport";
  const category = isTransport ? resolved.transportCategory : resolved.merchandiseCategory;
  const subCategory = isTransport ? resolved.transportSubCategory : resolved.merchandiseSubCategory;
  const largeCategoryId = isTransport ? resolved.transportLargeCategoryId : resolved.merchandiseLargeCategoryId;
  const middleCategoryId = isTransport ? resolved.transportMiddleCategoryId : resolved.merchandiseMiddleCategoryId;

  return {
    fingerprint: row.fingerprint,
    date: row.transactionDate,
    amount: row.amountAbs,
    balanceAfter: row.balanceAfter,
    account: resolved.suicaAccountName,
    content: row.mfContent ?? buildFallbackContent(row),
    category,
    subCategory,
    largeCategoryId,
    middleCategoryId,
    memo: `${resolved.memoPrefix}${row.fingerprint}`,
    rawLine: row.rawLine
  };
}

export function buildPostingPlan(rows, config = {}) {
  return rows
    .map((row) => buildMoneyForwardExpense(row, config))
    .filter(Boolean);
}

export async function postReadyRowsToMoneyForward(page, rows, options = {}) {
  const config = resolveMoneyForwardConfig(options);
  const plan = buildPostingPlan(rows, config);
  const maxPostRows = normalizePositiveInteger(options.maxPostRows, Infinity);
  const verifyBalanceEveryRows = normalizePositiveInteger(options.verifyBalanceEveryRows, 5);
  const verifyBalanceAfterFirstPost = options.verifyBalanceAfterFirstPost !== false;
  const stopBeforeElapsedMs = normalizePositiveInteger(options.stopBeforeElapsedMs, Infinity);
  const runStartedAt = Date.now();

  if (options.dryRun !== false) {
    return {
      mode: "dry_run",
      results: plan.map((expense) => ({
        fingerprint: expense.fingerprint,
        status: "ready",
        expense
      }))
    };
  }

  const results = [];
  let currentBalance = null;
  let postedAttemptCount = 0;
  let stoppedReason = null;
  let expectedBatchBalance = null;
  let postedSinceBalanceCheck = 0;

  if (options.credentials) {
    await loginToMoneyForward(page, options.credentials, config, options);
  }

  if (config.skipByCurrentBalance) {
    currentBalance = await getMoneyForwardCurrentBalance(page, config);
  }

  for (const expense of plan) {
    if (Date.now() - runStartedAt >= stopBeforeElapsedMs) {
      stoppedReason = "run_time_budget";
      break;
    }

    if (isAlreadyPostedByBalance(expense, currentBalance)) {
      results.push({
        fingerprint: expense.fingerprint,
        status: "skipped_balance",
        currentBalance,
        expense
      });
      continue;
    }

    if (postedAttemptCount >= maxPostRows) {
      stoppedReason = options.maxPostRowsStopReason ?? "max_post_rows";
      break;
    }

    const result = await postExpense(page, expense, {
      ...config,
      currentBalance
    });
    results.push(result);
    if (result.status !== "failed") {
      postedAttemptCount += 1;
    }
    if (result.status === "posted") {
      expectedBatchBalance = expense.balanceAfter ?? expectedBatchBalance;
      currentBalance = expense.balanceAfter ?? currentBalance;
      postedSinceBalanceCheck += 1;
    }

    if (result.status === "failed") {
      stoppedReason = "failed";
      break;
    }

    if (result.status === "unknown" && options.stopOnUnknown !== false) {
      stoppedReason = "unknown";
      break;
    }

    const shouldVerifyAfterThisPost = (
      expectedBatchBalance != null &&
      config.verifyBalanceAfterBatch !== false &&
      (
        (verifyBalanceAfterFirstPost && postedAttemptCount === 1) ||
        postedSinceBalanceCheck >= verifyBalanceEveryRows
      )
    );

    if (result.status === "posted" && config.postDelayMs > 0) {
      await delay(config.postDelayMs);
    }

    if (shouldVerifyAfterThisPost) {
      const verification = await verifyExpectedBalance(page, config, expectedBatchBalance);
      currentBalance = verification.currentBalance ?? currentBalance;
      postedSinceBalanceCheck = 0;
      if (!verification.ok) {
        stoppedReason = "balance_mismatch";
        results.push(verification.result);
        break;
      }
    }
  }

  if (
    !stoppedReason &&
    expectedBatchBalance != null &&
    postedSinceBalanceCheck > 0 &&
    config.verifyBalanceAfterBatch !== false
  ) {
    const verification = await verifyExpectedBalance(page, config, expectedBatchBalance);
    currentBalance = verification.currentBalance ?? currentBalance;
    if (!verification.ok) {
      stoppedReason = "balance_mismatch";
      results.push(verification.result);
    }
  }

  return {
    mode: "browser_run",
    currentBalance,
    postedAttemptCount,
    stoppedReason,
    partial: stoppedReason === "max_post_rows" || stoppedReason === "run_time_budget",
    resourcePolicy: {
      browserLaunches: 1,
      pages: 1,
      loginAttempts: options.credentials ? 1 : 0,
      balanceReconciliation: "enabled",
      postDelayMs: config.postDelayMs,
      stopBeforeElapsedMs
    },
    results
  };
}

async function verifyExpectedBalance(page, config, expectedBalance) {
  let verifiedBalance = null;
  const attempts = normalizePositiveInteger(config.balanceVerifyAttempts, 1);
  const intervalMs = normalizePositiveInteger(config.balanceVerifyIntervalMs, 0);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    verifiedBalance = await getMoneyForwardCurrentBalance(page, config);
    if (verifiedBalance === expectedBalance) {
      return { ok: true, currentBalance: verifiedBalance, attempts: attempt };
    }

    if (attempt < attempts && intervalMs > 0) {
      await delay(intervalMs);
    }
  }

  return {
    ok: false,
    currentBalance: verifiedBalance,
    result: {
      status: "unknown",
      error: `Money Forward balance did not reach ${expectedBalance}; current=${verifiedBalance}; attempts=${attempts}`,
      expectedBalance,
      currentBalance: verifiedBalance,
      attempts
    }
  };
}

function normalizePositiveInteger(value, fallback) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export async function loginToMoneyForward(page, credentials, config = {}, options = {}) {
  const resolved = resolveMoneyForwardConfig(config);
  await page.goto(resolved.loginUrl, { waitUntil: "networkidle0" });

  const emailInput = await page.$?.(resolved.selectors.emailInput);
  if (!emailInput) {
    return { alreadyLoggedIn: true };
  }

  await fillExistingInput(page, emailInput, resolved.selectors.emailInput, credentials.email);
  await fillInput(page, resolved.selectors.passwordInput, credentials.password);
  await click(page, resolved.selectors.loginSubmit);
  await waitForOptionalNavigation(page);

  const verificationInput = await page.$?.(resolved.selectors.verificationCodeInput);
  if (verificationInput) {
    const code = await pollForVerificationCode(options.env ?? credentials.env, page, resolved);
    await fillExistingInput(page, verificationInput, resolved.selectors.verificationCodeInput, code);
    await click(page, resolved.selectors.loginSubmit);
    await waitForOptionalNavigation(page);
    return { alreadyLoggedIn: false, verificationCodeSubmitted: true };
  }

  return { alreadyLoggedIn: false, verificationCodeSubmitted: false };
}

export async function postExpense(page, expense, config = {}) {
  const resolved = resolveMoneyForwardConfig(config);
  let submitted = false;

  try {
    if (isAlreadyPostedByBalance(expense, resolved.currentBalance)) {
      return {
        fingerprint: expense.fingerprint,
        status: "skipped_balance",
        currentBalance: resolved.currentBalance,
        expense
      };
    }

    await ensureManualEntryPage(page, resolved.manualExpenseUrl);
    await openManualEntryForm(page, resolved);
    await fillInput(page, resolved.selectors.dateInput, expense.date);
    await verifyManualEntryDate(page, resolved.selectors.dateInput, expense.date);
    await fillInput(page, resolved.selectors.amountInput, String(expense.amount));
    await fillInput(page, resolved.selectors.contentInput, expense.content);
    await fillInput(page, resolved.selectors.memoInput, expense.memo, { required: false });
    await selectByLabelOrValue(page, resolved.selectors.accountSelect, expense.account, { required: false });
    await setHiddenCategory(page, expense, resolved);
    await verifyManualEntryDatePayload(page, expense.date);

    const confirmation = waitForSubmitConfirmation(page, resolved).catch((error) => error);
    await click(page, resolved.selectors.submitButton);
    submitted = true;
    const confirmationResult = await confirmation;
    if (confirmationResult instanceof Error) throw confirmationResult;

    return {
      fingerprint: expense.fingerprint,
      status: "posted",
      expense
    };
  } catch (error) {
    return {
      fingerprint: expense.fingerprint,
      status: submitted ? "unknown" : "failed",
      error: error instanceof Error ? error.message : String(error),
      expense
    };
  }
}

async function ensureManualEntryPage(page, url) {
  if (!url) return;
  const currentUrl = typeof page.url === "function" ? page.url() : "";
  if (currentUrl && normalizeUrlPath(currentUrl) === normalizeUrlPath(url)) return;
  await page.goto(url, { waitUntil: "networkidle0" });
}

function normalizeUrlPath(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

async function openManualEntryForm(page, config) {
  await click(page, config.selectors.manualEntryButton, { required: false, timeoutMs: 3000 });
  await waitFor(page, config.selectors.amountInput, { timeoutMs: 10000 });
}

function isAlreadyPostedByBalance(expense, currentBalance) {
  return (
    typeof currentBalance === "number" &&
    typeof expense.balanceAfter === "number" &&
    expense.balanceAfter >= currentBalance
  );
}

async function getMoneyForwardCurrentBalance(page, config) {
  if (!config.suicaAccountDetailUrl) return null;

  try {
    await page.goto(config.suicaAccountDetailUrl, { waitUntil: "networkidle0" });
    return await page.evaluate(
      () => {
        const text = document.body?.textContent ?? "";
        const match = text.match(/残高：\s*([\d,]+)円/);
        return match ? Number(match[1].replaceAll(",", "")) : null;
      }
    );
  } catch {
    return null;
  }
}

export async function createCloudflareBrowserPage(env, puppeteerModule, options = {}) {
  const browserBinding = env?.BROWSER ?? env?.browser;
  if (!browserBinding) {
    throw new Error("env.BROWSER binding is required for Cloudflare Browser Run");
  }

  const launchOptions = {};
  if (options.keepAliveMs) {
    launchOptions.keep_alive = options.keepAliveMs;
  }

  const browser = Object.keys(launchOptions).length > 0
    ? await puppeteerModule.launch(browserBinding, launchOptions)
    : await puppeteerModule.launch(browserBinding);
  const page = await browser.newPage();
  return {
    browser,
    page,
    close: () => browser.close()
  };
}

export async function pollForVerificationCode(env, page, config = {}) {
  const resolved = resolveMoneyForwardConfig(config);
  if (!env?.SUICA_MF_KV) {
    throw new Error("env.SUICA_MF_KV binding is required for Money Forward verification code polling");
  }

  for (let index = 0; index < resolved.verificationPollAttempts; index += 1) {
    const code = await env.SUICA_MF_KV.get(resolved.verificationCodeKey);
    if (code) {
      await env.SUICA_MF_KV.delete(resolved.verificationCodeKey);
      return code;
    }

    await delay(resolved.verificationPollIntervalMs);
    await page.title();
  }

  throw new Error("Money Forward verification code was not received before timeout");
}

function resolveMoneyForwardConfig(config = {}) {
  return {
    ...DEFAULT_MF_CONFIG,
    ...config,
    selectors: {
      ...DEFAULT_MF_CONFIG.selectors,
      ...(config.selectors ?? {})
    }
  };
}

async function fillInput(page, selector, value, options = {}) {
  if (value == null || value === "") {
    if (options.required === false) return;
    throw new Error(`Missing value for selector ${selector}`);
  }

  const element = await waitFor(page, selector, options);
  if (!element) return;

  await fillExistingInput(page, element, selector, value);
}

async function fillExistingInput(page, element, selector, value) {
  if (selector === DEFAULT_MF_CONFIG.selectors.dateInput || selector.includes("calendar")) {
    await setManualEntryDate(page, value);
    return;
  }

  await element.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
}

async function click(page, selector, options = {}) {
  const element = await waitFor(page, selector, options);
  if (!element) return;
  await element.click();
}

async function selectByLabelOrValue(page, selector, value, options = {}) {
  if (value == null || value === "") {
    if (options.required === false) return;
    throw new Error(`Missing select value for selector ${selector}`);
  }

  const element = await waitFor(page, selector, options);
  if (!element) return;

  const selected = await page.evaluate(
    (selectSelector, wanted) => {
      const select = document.querySelector(selectSelector);
      if (!select) return false;
      const options = Array.from(select.options ?? []);
      const option = options.find((candidate) => candidate.value === wanted || candidate.textContent?.trim() === wanted);
      if (!option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    selector,
    value
  );

  if (!selected && options.required !== false) {
    throw new Error(`Unable to select ${value} with selector ${selector}`);
  }
}

async function waitFor(page, selector, options = {}) {
  try {
    return await page.waitForSelector(selector, { timeout: options.timeoutMs ?? 10000 });
  } catch (error) {
    if (options.required === false) return null;
    throw error;
  }
}

async function waitForSubmitConfirmation(page, config) {
  const timeout = config.confirmTimeoutMs ?? 10000;
  const candidates = [];

  if (typeof page.waitForResponse === "function") {
    candidates.push(page.waitForResponse(
      (response) => {
        const url = typeof response.url === "function" ? response.url() : "";
        const status = typeof response.status === "function" ? response.status() : 0;
        return status >= 200 && status < 400 && (
          url.includes("/cf/create") ||
          url.includes("/user_asset_acts")
        );
      },
      { timeout }
    ));
  }

  if (typeof page.waitForNavigation === "function") {
    candidates.push(page.waitForNavigation({ waitUntil: "networkidle0", timeout }));
  }

  try {
    await Promise.any(candidates);
  } catch {
    throw new Error("Money Forward submit confirmation timed out");
  }
}

async function setManualEntryDate(page, value) {
  const dateValue = value.replaceAll("-", "/");
  await optionalEval(
    page,
    DEFAULT_MF_CONFIG.selectors.dateInput,
    (el, nextDate) => {
      const win = el.ownerDocument?.defaultView;
      const jquery = win?.jQuery || win?.$;
      if (jquery?.fn?.datepicker) {
        try {
          jquery(el).datepicker("setValue", nextDate);
          jquery(el).datepicker("update", nextDate);
          jquery(el).datepicker("hide");
        } catch {
          // Fall through to the plain input update below.
        }
      }
      if ("value" in el) {
        const prototype = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor?.set) {
          descriptor.set.call(el, nextDate);
        } else {
          el.value = nextDate;
        }
      }
      el.setAttribute("data-date", nextDate);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    },
    dateValue
  );
  await optionalEval(
    page,
    DEFAULT_MF_CONFIG.selectors.dateHiddenInput,
    (el, nextDate) => {
      el.value = nextDate;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    dateValue
  );
  await optionalEval(
    page,
    DEFAULT_MF_CONFIG.selectors.dateLabel,
    (el, nextDate) => {
      el.textContent = nextDate;
    },
    dateValue
  );
}

async function verifyManualEntryDate(page, selector, expectedValue) {
  if (typeof page.$eval !== "function") return;
  const expected = expectedValue.replaceAll("-", "/");
  const actual = await page.$eval(
    selector,
    (el) => {
      const value = "value" in el ? el.value : "";
      return value || el.getAttribute("data-date") || "";
    }
  );

  if (typeof actual === "string" && actual && actual !== expected) {
    throw new Error(`Money Forward date field mismatch: expected=${expected} actual=${actual}`);
  }
}

async function verifyManualEntryDatePayload(page, expectedValue) {
  if (typeof page.evaluate !== "function") return;
  const expected = expectedValue.replaceAll("-", "/");
  const payload = await page.evaluate(() => {
    const form = document.querySelector("#form-user-asset-act");
    if (!form) return { found: false, values: [] };
    const values = new FormData(form).getAll("user_asset_act[updated_at]").map((value) => String(value));
    return { found: true, values };
  });

  if (payload?.found && !payload.values.includes(expected)) {
    throw new Error(`Money Forward date payload mismatch: expected=${expected} values=${payload.values.join(",")}`);
  }
}

async function optionalEval(page, selector, fn, value) {
  try {
    await page.$eval?.(selector, fn, value);
  } catch {
    // Some Money Forward forms use a plain text date field instead of the compact calendar fields.
  }
}

async function setHiddenCategory(page, expense, config) {
  if (expense.largeCategoryId) {
    await setHiddenValue(page, config.selectors.categoryHiddenInput, expense.largeCategoryId);
    await setLabelText(page, config.selectors.categoryLabel, expense.category);
  }

  if (expense.middleCategoryId) {
    await setHiddenValue(page, config.selectors.subCategoryHiddenInput, expense.middleCategoryId);
    await setLabelText(page, config.selectors.subCategoryLabel, expense.subCategory);
  }
}

async function setHiddenValue(page, selector, value) {
  await page.$eval?.(
    selector,
    (el, nextValue) => {
      el.value = nextValue;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value
  );
}

async function setLabelText(page, selector, value) {
  await page.$eval?.(
    selector,
    (el, nextValue) => {
      const caret = el.querySelector(".caret");
      el.textContent = nextValue;
      if (caret) el.appendChild(caret);
    },
    value
  );
}

async function waitForOptionalNavigation(page) {
  try {
    await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 10000 });
  } catch {
    // Money Forward may submit with XHR instead of a full navigation.
  }
}

function buildFallbackContent(row) {
  if (row.entryLabel || row.exitLabel) {
    return `Suica ${[row.entryLabel, row.exitLabel].filter(Boolean).join(" -> ")}`;
  }
  return `Suica ${row.suicaType}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
