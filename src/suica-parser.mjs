import { createHash } from "node:crypto";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

const PDFJS_FALLBACK_PATH = process.env.PDFJS_DIST_PATH;

const COLUMNS = {
  month: [145, 178],
  day: [178, 205],
  type1: [205, 255],
  station1: [255, 320],
  type2: [320, 365],
  station2: [365, 425],
  balance: [425, 495],
  amount: [495, 555]
};

const MONEY_RE = /^[\\¥]?\d[\d,]*$/;
const SIGNED_MONEY_RE = /^[+-]\d[\d,]*$/;

export async function parseSuicaPdf(filePath, options = {}) {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(filePath);
  return parseSuicaPdfBytes(new Uint8Array(bytes), {
    sourceName: filePath,
    ...options
  });
}

export async function parseSuicaPdfBytes(bytes, options = {}) {
  const cutover = buildCutoverOptions(options);
  const pdfjs = await loadPdfJs();
  configurePdfJsWorker(pdfjs);
  const pdf = await pdfjs.getDocument({
    data: bytes,
    disableWorker: true,
    useSystemFonts: true
  }).promise;

  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ disableCombineTextItems: false });
    pages.push({
      pageNumber,
      rows: groupTextItemsIntoRows(content.items)
    });
  }

  const metadata = extractMetadata(pages, options);
  const rows = [];

  for (const page of pages) {
    for (const row of page.rows) {
      const parsed = parseTransactionRow(row, metadata, page.pageNumber);
      if (parsed) rows.push(parsed);
    }
  }

  inferYears(rows, metadata.reportDate);
  annotateBalanceChain(rows);

  for (const row of rows) {
    row.fingerprint = createFingerprint(row);
  }
  applyCutover(rows, cutover);

  return {
    source: "mobile-suica",
    sourceName: options.sourceName ?? null,
    cardSuffix: metadata.cardSuffix,
    reportDate: metadata.reportDate,
    rowCountLabel: metadata.rowCountLabel,
    cutover,
    transactions: rows
  };
}

async function loadPdfJs() {
  ensurePdfJsRuntime();
  try {
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (error) {
    if (!PDFJS_FALLBACK_PATH) throw error;
    const { pathToFileURL } = await import("node:url");
    return import(pathToFileURL(PDFJS_FALLBACK_PATH).href);
  }
}

function configurePdfJsWorker(pdfjs) {
  if (!pdfjs.GlobalWorkerOptions) return;
  pdfjs.GlobalWorkerOptions.workerPort = null;
}

function ensurePdfJsRuntime() {
  globalThis.pdfjsWorker ??= pdfjsWorker;
  if (!globalThis.DOMMatrix) {
    globalThis.DOMMatrix = MinimalDOMMatrix;
  }
  if (!globalThis.Path2D) {
    globalThis.Path2D = MinimalPath2D;
  }
  if (!globalThis.ImageData) {
    globalThis.ImageData = MinimalImageData;
  }
}

class MinimalDOMMatrix {
  constructor(init) {
    const values = Array.isArray(init) || ArrayBuffer.isView(init) ? Array.from(init) : null;
    this.a = values?.[0] ?? 1;
    this.b = values?.[1] ?? 0;
    this.c = values?.[2] ?? 0;
    this.d = values?.[3] ?? 1;
    this.e = values?.[4] ?? 0;
    this.f = values?.[5] ?? 0;
  }

  multiplySelf(other) {
    const a = this.a * other.a + this.c * other.b;
    const b = this.b * other.a + this.d * other.b;
    const c = this.a * other.c + this.c * other.d;
    const d = this.b * other.c + this.d * other.d;
    const e = this.a * other.e + this.c * other.f + this.e;
    const f = this.b * other.e + this.d * other.f + this.f;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
    return this;
  }

  preMultiplySelf(other) {
    return this.copyFrom(new MinimalDOMMatrix(other).multiplySelf(this));
  }

  translate(x = 0, y = 0) {
    return this.multiplySelf(new MinimalDOMMatrix([1, 0, 0, 1, x, y]));
  }

  scale(scaleX = 1, scaleY = scaleX) {
    return this.multiplySelf(new MinimalDOMMatrix([scaleX, 0, 0, scaleY, 0, 0]));
  }

  invertSelf() {
    const determinant = this.a * this.d - this.b * this.c;
    if (!determinant) return this.copyFrom(new MinimalDOMMatrix([NaN, NaN, NaN, NaN, NaN, NaN]));
    return this.copyFrom(new MinimalDOMMatrix([
      this.d / determinant,
      -this.b / determinant,
      -this.c / determinant,
      this.a / determinant,
      (this.c * this.f - this.d * this.e) / determinant,
      (this.b * this.e - this.a * this.f) / determinant
    ]));
  }

  copyFrom(other) {
    this.a = other.a;
    this.b = other.b;
    this.c = other.c;
    this.d = other.d;
    this.e = other.e;
    this.f = other.f;
    return this;
  }
}

class MinimalPath2D {
  addPath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  closePath() {}
  rect() {}
}

class MinimalImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

function groupTextItemsIntoRows(items) {
  const rows = [];

  for (const item of items) {
    if (!item.str) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= 1.5);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({
      text: item.str,
      x,
      y,
      width: item.width ?? 0
    });
  }

  return rows
    .map((row) => ({
      y: row.y,
      items: row.items.sort((a, b) => a.x - b.x),
      text: normalizeSpaces(row.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(" "))
    }))
    .sort((a, b) => b.y - a.y);
}

function extractMetadata(pages, options) {
  let cardSuffix = options.cardSuffix ?? null;
  let reportDate = options.reportDate ?? null;
  let rowCountLabel = null;

  for (const page of pages) {
    for (const row of page.rows) {
      const cardMatch = row.text.match(/JE\*{3}\s+\*{4}\s+\*{4}\s+(\d{4})/);
      if (!cardSuffix && cardMatch) cardSuffix = cardMatch[1];

      const countMatch = row.text.match(/残高履歴\s+（(\d+)件）/);
      if (!rowCountLabel && countMatch) rowCountLabel = Number(countMatch[1]);

      const dateMatch = row.text.match(/\b(20\d{2})\/(\d{1,2})\/(\d{1,2})\b/);
      if (!reportDate && dateMatch) {
        reportDate = `${dateMatch[1]}-${pad2(dateMatch[2])}-${pad2(dateMatch[3])}`;
      }
    }
  }

  return {
    cardSuffix,
    reportDate,
    rowCountLabel
  };
}

function parseTransactionRow(row, metadata, pageNumber) {
  const cells = extractCells(row.items);
  if (!/^\d{2}$/.test(cells.month) || !/^\d{2}$/.test(cells.day)) return null;
  if (!MONEY_RE.test(cells.balance)) return null;

  const signedAmount = SIGNED_MONEY_RE.test(cells.amount) ? parseMoney(cells.amount) : null;
  const balanceAfter = parseMoney(cells.balance);
  const normalizedType = normalizeSuicaType(cells.type1);
  const rawLine = buildRawLine(cells);
  const transactionDate = metadata.reportDate
    ? `${metadata.reportDate.slice(0, 4)}-${cells.month}-${cells.day}`
    : null;

  return {
    pageNumber,
    cardSuffix: metadata.cardSuffix,
    reportDate: metadata.reportDate,
    month: Number(cells.month),
    day: Number(cells.day),
    transactionDate,
    suicaType: normalizedType,
    entryLabel: cells.station1 || null,
    exitType: normalizeSuicaType(cells.type2) || null,
    exitLabel: cells.station2 || null,
    balanceAfter,
    signedAmount,
    amountAbs: signedAmount == null ? null : Math.abs(signedAmount),
    rawLine,
    normalizedLine: normalizeLine(rawLine),
    mfKind: classifyMoneyForwardKind(normalizedType, signedAmount),
    mfContent: buildMoneyForwardContent(normalizedType, cells),
    mfCategory: classifyMoneyForwardCategory(normalizedType, signedAmount),
    status: classifyInitialStatus(normalizedType, signedAmount),
    balanceChainValid: null,
    fingerprint: null
  };
}

function extractCells(items) {
  const cells = Object.fromEntries(Object.keys(COLUMNS).map((key) => [key, ""]));

  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    const key = findColumn(item.x);
    if (!key) continue;
    cells[key] = normalizeSpaces(`${cells[key]} ${text}`);
  }

  return cells;
}

function findColumn(x) {
  for (const [key, [min, max]] of Object.entries(COLUMNS)) {
    if (x >= min && x < max) return key;
  }
  return null;
}

function inferYears(rows, reportDate) {
  if (!reportDate) return;
  const reportYear = Number(reportDate.slice(0, 4));
  const reportMonth = Number(reportDate.slice(5, 7));

  for (const row of rows) {
    const year = row.month > reportMonth ? reportYear - 1 : reportYear;
    row.transactionDate = `${year}-${pad2(row.month)}-${pad2(row.day)}`;
  }
}

function annotateBalanceChain(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];

    if (!previous || current.signedAmount == null) {
      current.balanceChainValid = null;
      continue;
    }

    current.balanceChainValid = previous.balanceAfter + current.signedAmount === current.balanceAfter;
    if (!current.balanceChainValid && current.status === "ready") {
      current.status = "needs_review";
    }
  }
}

function applyCutover(rows, cutover) {
  const boundaryIndex = findCutoverBoundaryIndex(rows, cutover);
  if (boundaryIndex != null) {
    const boundary = rows[boundaryIndex];
    cutover.matchedFingerprint = boundary.fingerprint;
    cutover.matchedBalanceAfter = boundary.balanceAfter;
    cutover.matchedSignedAmount = boundary.signedAmount;
    cutover.matchedTransactionDate = boundary.transactionDate;
    boundary.cutoverCursor = true;

    for (let index = 0; index <= boundaryIndex; index += 1) {
      const row = rows[index];
      if (isCutoverMutableStatus(row.status)) {
        row.status = "before_cutover";
        row.cutoverReason = `at or before boundary row ${boundary.fingerprint}`;
      }
    }
    return;
  }

  if (!cutover.lastEnteredDate) return;

  for (const row of rows) {
    if (!row.transactionDate) continue;
    const isBeforeCutover = cutover.includeLastEnteredDate
      ? row.transactionDate <= cutover.lastEnteredDate
      : row.transactionDate < cutover.lastEnteredDate;

    if (isBeforeCutover && isCutoverMutableStatus(row.status)) {
      row.status = "before_cutover";
      row.cutoverReason = cutover.includeLastEnteredDate
        ? `transaction_date <= ${cutover.lastEnteredDate}`
        : `transaction_date < ${cutover.lastEnteredDate}`;
    }
  }
}

function isCutoverMutableStatus(status) {
  return status === "ready" || status === "needs_review" || status === "ignored";
}

function findCutoverBoundaryIndex(rows, cutover) {
  if (cutover.lastPostedFingerprint) {
    const index = rows.findIndex((row) => row.fingerprint === cutover.lastPostedFingerprint);
    if (index === -1) {
      throw new Error(`No Suica row matches lastPostedFingerprint: ${cutover.lastPostedFingerprint}`);
    }
    return index;
  }

  const hasBoundarySelector =
    cutover.lastEnteredBalanceAfter != null ||
    cutover.lastEnteredSignedAmount != null ||
    cutover.lastEnteredAmountAbs != null;

  if (!hasBoundarySelector) return null;
  if (!cutover.lastEnteredDate) {
    throw new Error("lastEnteredDate is required when selecting a cutover boundary row");
  }

  const matches = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.transactionDate === cutover.lastEnteredDate)
    .filter(({ row }) =>
      cutover.lastEnteredBalanceAfter == null
        ? true
        : row.balanceAfter === cutover.lastEnteredBalanceAfter
    )
    .filter(({ row }) =>
      cutover.lastEnteredSignedAmount == null
        ? true
        : row.signedAmount === cutover.lastEnteredSignedAmount
    )
    .filter(({ row }) =>
      cutover.lastEnteredAmountAbs == null
        ? true
        : row.amountAbs === cutover.lastEnteredAmountAbs
    );

  if (matches.length === 0) {
    throw new Error(`No Suica row matches the last entered Money Forward boundary: ${describeCutover(cutover)}`);
  }

  if (matches.length > 1) {
    throw new Error(`Multiple Suica rows match the last entered Money Forward boundary: ${describeCutover(cutover)}`);
  }

  return matches[0].index;
}

function createFingerprint(row) {
  const source = [
    "mobile-suica",
    row.cardSuffix ?? "",
    row.transactionDate ?? "",
    row.signedAmount ?? "",
    row.balanceAfter,
    row.normalizedLine
  ].join("|");

  return createHash("sha256").update(source).digest("hex");
}

function classifyMoneyForwardKind(type, signedAmount) {
  if (signedAmount == null) return "opening_balance";
  if (signedAmount > 0) return "charge";
  if (type === "物販") return "expense_merchandise";
  return "expense_transport";
}

function classifyMoneyForwardCategory(type, signedAmount) {
  if (signedAmount == null || signedAmount > 0) return null;
  if (type === "物販") return "未分類";
  return "交通費";
}

function classifyInitialStatus(_type, signedAmount) {
  if (signedAmount == null) return "ignored";
  if (signedAmount > 0) return "needs_review";
  return "ready";
}

function buildMoneyForwardContent(type, cells) {
  if (type === "物販") return "Suica 物販";
  if (type === "カード") return "Suica チャージ";
  if (type === "現金") return "Suica 現金チャージ";

  const route = [cells.station1, cells.station2].filter(Boolean).join(" -> ");
  return route ? `Suica ${route}` : `Suica ${type}`;
}

function buildRawLine(cells) {
  return [
    cells.month,
    cells.day,
    cells.type1,
    cells.station1,
    cells.type2,
    cells.station2,
    cells.balance,
    cells.amount
  ].filter(Boolean).join(" ");
}

function normalizeSuicaType(value) {
  return normalizeSpaces(value).replaceAll("ｶｰﾄﾞ", "カード");
}

function normalizeLine(value) {
  return normalizeSpaces(value)
    .replaceAll("ｶｰﾄﾞ", "カード")
    .replaceAll("¥", "\\");
}

function normalizeSpaces(value) {
  return value.replace(/\s+/g, " ").trim();
}

function parseMoney(value) {
  const normalized = value.replace(/[\\¥,]/g, "");
  return Number(normalized);
}

function buildCutoverOptions(options) {
  const amount = normalizeAmountOption(options.lastEnteredAmount);
  return {
    lastPostedFingerprint: normalizeFingerprintOption(
      options.lastPostedFingerprint ?? options.postedThroughFingerprint
    ),
    lastEnteredDate: normalizeDateOption(options.lastEnteredDate),
    lastEnteredBalanceAfter: normalizeIntegerOption(options.lastEnteredBalanceAfter, "lastEnteredBalanceAfter"),
    lastEnteredSignedAmount: amount?.signedAmount ?? null,
    lastEnteredAmountAbs: amount?.amountAbs ?? null,
    includeLastEnteredDate: options.includeLastEnteredDate !== false
  };
}

function normalizeFingerprintOption(value) {
  if (value == null || value === "") return null;
  const fingerprint = String(value).trim();
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error("lastPostedFingerprint must be a 64-character sha256 hex string");
  }
  return fingerprint.toLowerCase();
}

function normalizeDateOption(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("lastEnteredDate must be a YYYY-MM-DD string");
  }

  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    throw new Error("lastEnteredDate must be formatted as YYYY-MM-DD");
  }

  const normalized = `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`lastEnteredDate is not a valid date: ${value}`);
  }

  return normalized;
}

function normalizeAmountOption(value) {
  if (value == null || value === "") return null;
  const text = String(value).replace(/[\\¥,\s円]/g, "");
  if (/^[+-]\d+$/.test(text)) {
    return {
      signedAmount: Number(text),
      amountAbs: null
    };
  }
  if (/^\d+$/.test(text)) {
    return {
      signedAmount: null,
      amountAbs: Number(text)
    };
  }
  throw new Error("lastEnteredAmount must be an integer amount such as 218, -218, or +15000");
}

function normalizeIntegerOption(value, name) {
  if (value == null || value === "") return null;
  const text = String(value).replace(/[\\¥,\s円]/g, "");
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be an integer amount`);
  }
  return Number(text);
}

function describeCutover(cutover) {
  return JSON.stringify({
    lastEnteredDate: cutover.lastEnteredDate,
    lastEnteredAmount:
      cutover.lastEnteredSignedAmount ?? cutover.lastEnteredAmountAbs ?? undefined,
    lastEnteredBalanceAfter: cutover.lastEnteredBalanceAfter ?? undefined
  });
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
