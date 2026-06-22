import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { parseSuicaPdf } from "../src/suica-parser.mjs";

const samplePdf = process.env.SAMPLE_SUICA_PDF;

test("parses Mobile Suica balance history rows", { skip: !samplePdf || !existsSync(samplePdf) }, async () => {
  const parsed = await parseSuicaPdf(samplePdf);

  assert.equal(parsed.cardSuffix, "8933");
  assert.equal(parsed.reportDate, "2026-06-06");
  assert.equal(parsed.rowCountLabel, 65);
  assert.equal(parsed.transactions.length, 65);

  const first = parsed.transactions[0];
  assert.equal(first.transactionDate, "2026-03-30");
  assert.equal(first.suicaType, "カード");
  assert.equal(first.balanceAfter, 1000);
  assert.equal(first.signedAmount, null);
  assert.equal(first.status, "ignored");

  const cashCharge = parsed.transactions[1];
  assert.equal(cashCharge.transactionDate, "2026-03-31");
  assert.equal(cashCharge.signedAmount, 200);
  assert.equal(cashCharge.mfKind, "charge");
  assert.equal(cashCharge.status, "needs_review");
  assert.equal(cashCharge.balanceChainValid, true);

  const firstCommute = parsed.transactions.find(
    (row) => row.transactionDate === "2026-04-08" && row.suicaType === "定"
  );
  assert.ok(firstCommute);
  assert.equal(firstCommute.entryLabel, "地 駅A");
  assert.equal(firstCommute.exitType, "出");
  assert.equal(firstCommute.exitLabel, "地駅B");
  assert.equal(firstCommute.signedAmount, -209);
  assert.equal(firstCommute.mfCategory, "交通費");
  assert.equal(firstCommute.status, "ready");

  const brokenRows = parsed.transactions.filter((row) => row.balanceChainValid === false);
  assert.deepEqual(brokenRows, []);
});

test("marks rows on or before the last Money Forward entered date as before_cutover", { skip: !samplePdf || !existsSync(samplePdf) }, async () => {
  const parsed = await parseSuicaPdf(samplePdf, { lastEnteredDate: "2026-05-17" });

  assert.equal(parsed.transactions.length, 65);
  assert.equal(parsed.cutover.lastEnteredDate, "2026-05-17");
  assert.equal(parsed.cutover.includeLastEnteredDate, true);

  const beforeCutover = parsed.transactions.filter((row) => row.status === "before_cutover");
  assert.equal(beforeCutover.length, 52);
  assert.ok(beforeCutover.every((row) => row.transactionDate <= "2026-05-17"));

  const firstPostable = parsed.transactions.find(
    (row) => row.transactionDate === "2026-05-18" && row.suicaType === "定"
  );
  assert.ok(firstPostable);
  assert.equal(firstPostable.status, "ready");
});

test("can keep rows on the last entered date postable when requested", { skip: !samplePdf || !existsSync(samplePdf) }, async () => {
  const parsed = await parseSuicaPdf(samplePdf, {
    lastEnteredDate: "2026-05-17",
    includeLastEnteredDate: false
  });

  const beforeCutover = parsed.transactions.filter((row) => row.status === "before_cutover");
  assert.equal(beforeCutover.length, 50);
  assert.ok(beforeCutover.every((row) => row.transactionDate < "2026-05-17"));

  const lastEnteredDayExpense = parsed.transactions.find(
    (row) => row.transactionDate === "2026-05-17" && row.signedAmount === -1000
  );
  assert.ok(lastEnteredDayExpense);
  assert.equal(lastEnteredDayExpense.status, "ready");
});

test("can cut over at an exact last entered row by date, amount, and balance", { skip: !samplePdf || !existsSync(samplePdf) }, async () => {
  const parsed = await parseSuicaPdf(samplePdf, {
    lastEnteredDate: "2026-05-30",
    lastEnteredAmount: "218",
    lastEnteredBalanceAfter: "16,174"
  });

  const beforeCutover = parsed.transactions.filter((row) => row.status === "before_cutover");
  assert.equal(beforeCutover.length, 62);
  assert.equal(parsed.cutover.matchedTransactionDate, "2026-05-30");
  assert.equal(parsed.cutover.matchedSignedAmount, -218);
  assert.equal(parsed.cutover.matchedBalanceAfter, 16174);

  const nextRow = parsed.transactions.find((row) => row.balanceAfter === 14953);
  assert.ok(nextRow);
  assert.equal(nextRow.status, "ready");
});

test("rejects mismatched exact cutover row selectors", { skip: !samplePdf || !existsSync(samplePdf) }, async () => {
  await assert.rejects(
    parseSuicaPdf(samplePdf, {
      lastEnteredDate: "2026-05-30",
      lastEnteredAmount: "218",
      lastEnteredBalanceAfter: "13,705"
    }),
    /No Suica row matches/
  );
});

test("can cut over from a saved Money Forward cursor fingerprint", { skip: !samplePdf || !existsSync(samplePdf) }, async () => {
  const firstPass = await parseSuicaPdf(samplePdf);
  const cursor = firstPass.transactions.find(
    (row) => row.transactionDate === "2026-05-30" && row.signedAmount === -218
  );
  assert.ok(cursor);

  const parsed = await parseSuicaPdf(samplePdf, {
    lastPostedFingerprint: cursor.fingerprint
  });

  const beforeCutover = parsed.transactions.filter((row) => row.status === "before_cutover");
  assert.equal(beforeCutover.length, 62);
  assert.equal(parsed.cutover.matchedFingerprint, cursor.fingerprint);
  assert.equal(parsed.cutover.matchedSignedAmount, -218);
  assert.equal(parsed.transactions.find((row) => row.fingerprint === cursor.fingerprint).cutoverCursor, true);
});
