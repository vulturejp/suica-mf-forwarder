#!/usr/bin/env node
import { parseSuicaPdf } from "../src/suica-parser.mjs";

try {
  const { pdfPath, options } = parseArgs(process.argv.slice(2));

  if (!pdfPath) {
    console.error(
      [
        "Usage: node bin/parse-suica.mjs [options] <mobile-suica-pdf>",
        "",
        "Options:",
        "  --last-posted-fingerprint SHA  Mark rows up to this saved MF cursor as before_cutover.",
        "  --last-entered-date YYYY-MM-DD  Mark rows on or before this date as before_cutover.",
        "  --last-entered-amount AMOUNT    Select the exact boundary row by amount, e.g. 218 or -218.",
        "  --last-entered-balance AMOUNT   Select the exact boundary row by balance after the transaction.",
        "  --exclude-last-entered-date     Mark only rows before --last-entered-date as before_cutover."
      ].join("\n")
    );
    process.exit(1);
  }

  const parsed = await parseSuicaPdf(pdfPath, options);
  console.log(JSON.stringify(parsed, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function parseArgs(args) {
  const options = {};
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--last-entered-date") {
      options.lastEnteredDate = args[index + 1];
      index += 1;
    } else if (arg === "--last-posted-fingerprint") {
      options.lastPostedFingerprint = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--last-posted-fingerprint=")) {
      options.lastPostedFingerprint = arg.slice("--last-posted-fingerprint=".length);
    } else if (arg.startsWith("--last-entered-date=")) {
      options.lastEnteredDate = arg.slice("--last-entered-date=".length);
    } else if (arg === "--last-entered-amount") {
      options.lastEnteredAmount = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--last-entered-amount=")) {
      options.lastEnteredAmount = arg.slice("--last-entered-amount=".length);
    } else if (arg === "--last-entered-balance") {
      options.lastEnteredBalanceAfter = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--last-entered-balance=")) {
      options.lastEnteredBalanceAfter = arg.slice("--last-entered-balance=".length);
    } else if (arg === "--exclude-last-entered-date") {
      options.includeLastEnteredDate = false;
    } else if (arg === "--include-last-entered-date") {
      options.includeLastEnteredDate = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return {
    pdfPath: positional[0],
    options
  };
}
