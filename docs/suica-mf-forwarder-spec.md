# Suica PDF to Money Forward Forwarder Specification

## Goal

Mobile Suica cannot be reliably automated because login and session handling are difficult. This system therefore automates only the Money Forward side.

The user manually provides a Mobile Suica balance usage PDF. The system parses the PDF, converts each Suica row into a transaction candidate, prevents duplicate posting, and posts eligible spending transactions to Money Forward using Cloudflare Browser Run.

Charge transfer handling may be automated in a simplified way. Because Suica charge routes can vary and card statements may later be imported separately, the safe default is either manual handling or provisional transfer from cash.

## Source Input

The input is a Mobile Suica PDF similar to:

```text
モバイル Suica 残高ご利用明細
月 日 種別 利用駅 種別 利用駅 残高 入金・利用額
04 08 定 地 駅A 出 地駅B \15,055 -209
05 30 カード モバイル \16,392 +15,000
06 13 物販 \8,506 -1,000
```

The PDF is treated as the source of truth for Suica transaction identity. Money Forward text, category, and edited content are not used for duplicate detection.

## Architecture

```text
Email Worker
  Receives email with attached Suica PDF
  Parses the attachment in the Worker request

Parser Worker
  Extracts text using a JavaScript PDF parser such as pdfjs-dist
  Normalizes Suica rows
  Writes parsed rows and fingerprints to D1
  Sends postable rows to the Money Forward Queue

Money Forward Consumer Worker
  Uses Cloudflare Browser Run with @cloudflare/puppeteer
  Logs in to Money Forward
  Posts transactions or transfers
  Updates D1 posting status

Review UI Worker
  Shows parsed rows, unknown posting results, and review-needed rows
  Allows manual confirmation, ignore, retry, or metadata edits
```

## Cloudflare Components

- Workers: Email receiving, parsing, posting, review UI.
- D1: Stores transaction ledger and posting state.
- Queues: Decouples PDF parsing and Money Forward posting.
- Browser Run: Runs headless browser automation for Money Forward.
- KV or D1: Stores Money Forward two-factor verification code if needed.

## PDF Parsing

PDF parsing should run in Workers if the parser bundle and memory usage are acceptable.

Use a JavaScript PDF parser, likely `pdfjs-dist`, and extract text items with coordinates. Do not depend only on plain extracted text order. Group text items by row using their y-coordinate, then normalize each row.

The parser must extract:

- Card suffix, for example `8933`.
- Report date, for example `2026/6/15`.
- Month and day.
- Transaction type.
- Entry station or label.
- Exit station or label.
- Balance after transaction.
- Signed amount.
- Raw row text.

The year is inferred from the report date and row month. If the PDF can span a year boundary, month order must be used to infer the correct year.

## Transaction Classification

### Transport Expense

Examples:

```text
04 08 定 地 駅A 出 地駅B \15,055 -209
06 13 入 私鉄A駅 出 私鉄B駅 \8,010 -140
06 13 バス等 路線バスA \9,826 -320
```

Money Forward handling:

- Account: Suica wallet.
- Type: expense.
- Category: transport.
- Content: route or bus label.

### Merchandise

Example:

```text
06 13 物販 \8,506 -1,000
```

Money Forward handling:

- Account: Suica wallet.
- Type: expense.
- Category/content may be generic at first.

Important: Money Forward entries may later be manually edited by the user, because Suica PDF only says `物販` and does not include the purchased item or store. This must not cause duplicate posting.

### Charge

Examples:

```text
05 30 カード モバイル \16,392 +15,000
03 31 現金 \1,200 +200
```

Money Forward handling:

- Do not post charge rows as income.
- Store charge rows for audit and balance-chain validation.
- If provisional charge automation is enabled, post charge rows as transfers from the cash wallet into the Suica wallet.
- Do not automatically choose a real credit card as the transfer source.

Recommended status:

```text
ignored
  if the row is only needed for duplicate and balance context.

needs_review
  if the user wants the review UI to show manual-transfer reminders or choose the transfer source.

ready
  if provisional charge transfer automation is enabled.
```

## Money Forward Duplicate Prevention

The core rule is:

**Never decide duplication by searching Money Forward text, category, or edited transaction content. Use the local D1 ledger generated from the Suica PDF.**

Money Forward entries can be edited after posting. For example:

```text
PDF row:
  2026-06-13 物販 -1000 balance=8506

Initially posted to Money Forward:
  content = Suica 物販
  category = 未分類

User edits in Money Forward:
  content = コンビニ 朝食
  category = 食費
```

The system must still recognize the row as already posted when the same PDF row appears again in a later PDF.

## Fingerprint

Each Suica row gets a stable fingerprint based only on PDF-derived fields:

```text
sha256(
  source = "mobile-suica" + "|" +
  card_suffix + "|" +
  transaction_date + "|" +
  signed_amount + "|" +
  balance_after + "|" +
  normalized_raw_line
)
```

`balance_after` is included because Suica can have multiple same-day, same-amount transactions. The balance sequence makes collisions much less likely.

Do not include Money Forward fields such as:

- Money Forward content.
- Money Forward category.
- User-edited label.
- Money Forward memo.
- Money Forward account display name.

## Posting Ledger

D1 should have a table similar to:

```sql
CREATE TABLE suica_transactions (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  card_suffix TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  signed_amount INTEGER NOT NULL,
  amount_abs INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  suica_type TEXT NOT NULL,
  entry_label TEXT,
  exit_label TEXT,
  raw_line TEXT NOT NULL,
  normalized_line TEXT NOT NULL,
  mf_kind TEXT NOT NULL,
  mf_account TEXT,
  mf_content TEXT,
  mf_category TEXT,
  status TEXT NOT NULL,
  mf_entry_id TEXT,
  pdf_object_key TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  posted_at TEXT,
  updated_at TEXT NOT NULL
);
```

Recommended statuses:

```text
parsed
  Parsed from PDF, not yet queued for MF.

needs_review
  Requires user decision before posting. Use for ambiguous charge rows,
  merchandise rows if desired, or parser confidence issues.

ready
  Ready to post to MF.

posting
  Browser Run is currently trying to post it.

posted
  Posting succeeded or is confidently treated as succeeded.

unknown
  Submit may have happened, but success confirmation failed. Do not auto-retry.

failed
  Failed before submit. Safe to retry.

ignored
  User or rule decided not to post.
```

## Posting State Rules

### Before Posting

When a parsed row is seen:

1. Compute fingerprint.
2. Insert into D1 if absent.
3. If fingerprint already exists, update `last_seen_at` and skip Money Forward posting.
4. Only rows with status `ready` or retryable `failed` may be sent to the MF Queue.

### During Posting

Before Browser Run starts entering a row:

1. Atomically change status from `ready` or retryable `failed` to `posting`.
2. If the row is no longer in a retryable state, skip it.

This prevents two queue consumers from posting the same row concurrently.

### After Posting

If the system can confirm that the Money Forward entry exists:

```text
posting -> posted
```

If the browser clicked submit but failed before confirmation:

```text
posting -> unknown
```

Do not automatically retry `unknown`, because it may already be in Money Forward.

If the failure happened before submit:

```text
posting -> failed
```

`failed` may be retried.

## Handling Unknown Results

`unknown` exists specifically to prevent duplicate Money Forward input.

Common causes:

- Browser Run timeout after submit.
- Network error while waiting for confirmation.
- Money Forward page changed after submit.
- Worker crash after submit.

The review UI must show `unknown` rows and allow the user to choose:

- Mark as posted.
- Mark as failed and retry.
- Ignore.

Automatic retry of `unknown` is forbidden.

## Initial Import And Cutover

Initial import needs a separate safety process because Money Forward may already contain manually entered Suica transactions.

The system must not blindly post all rows from the first PDF. Before the first automatic posting run, create the local D1 ledger from the PDF and decide which rows are already represented in Money Forward.

### Cutover Modes

Recommended modes:

```text
dry_run
  Parse PDF and create D1 rows, but do not post to Money Forward.

mark_existing
  Mark selected rows as already_entered when they were manually entered in MF.

post_after_cutover
  Only post rows after a configured cutover date/time or selected cutover fingerprint.
```

For first-time setup, the user may only know the last date that was already
manually entered into Money Forward. The parser and ledger import must support
that simpler setting:

```text
last_entered_date
  Store every PDF row in the local ledger.
  Mark rows on or before this date as before_cutover by default.
  Only rows after this date can become ready for Money Forward posting.
```

The default is inclusive because a date-only boundary cannot distinguish which
same-day Suica rows were already entered. If the user intentionally wants to
post entries on that date, allow an explicit exclusive mode that marks only rows
before `last_entered_date` as `before_cutover`.

If the last Money Forward row can be identified from the Suica PDF, prefer an
exact boundary row over a date-only setting:

```text
last_entered_date = 2026-05-30
last_entered_amount = -218
last_entered_balance_after = 16174
```

The parser should find exactly one matching Suica row and mark that row and all
earlier rows as `before_cutover`. If the amount and balance do not point to the
same Suica row, stop with an error instead of guessing. For example, if `-218`
on `2026-05-30` has balance `16174`, but balance `13705` belongs to a later
`-533` row on the same date, the settings are inconsistent and must be corrected
before posting.

After automatic posting starts, do not keep asking the user for dates or
balances. Store a durable cursor on the Suica card:

```text
last_posted_fingerprint
  Fingerprint of the latest Suica PDF row that has been successfully posted or
  intentionally treated as already handled in Money Forward.
```

On every later PDF parse, find this fingerprint in the parsed chronological
sequence. Mark that row and all earlier rows as `before_cutover`; only rows
after it can become `ready`. If the fingerprint is not present in the PDF,
stop and ask for a newer/older overlapping PDF or manual recovery. Do not fall
back to date matching silently.

When a Money Forward posting succeeds, advance `last_posted_fingerprint` to
that row. If a batch posts several rows, advance it after each confirmed row,
or once at the end to the last confirmed row. If a row becomes `unknown`, do not
advance past it automatically because the system cannot safely know whether it
was created in Money Forward.

Add one extra status:

```text
already_entered
  This PDF row is believed to already exist in Money Forward because it was
  manually entered before automation started. Never auto-post it.

before_cutover
  This PDF row is at or before the automation cutover boundary. It is kept for
  audit and balance context, but is never posted to Money Forward.
```

### Recommended First-Time Flow

1. User sends a Suica PDF that starts after the last manually entered Money Forward transaction, when possible.
2. Parser creates D1 rows and fingerprints with status `parsed`, but no MF posting happens.
3. User sets the automation cutover boundary. Prefer a concrete boundary row over only a date when the same day has both manual and automatic entries.
4. System stores the boundary in D1 configuration.
5. Rows at or before the boundary become `before_cutover` or `already_entered`.
6. Rows after the boundary become `ready`, subject to balance validation and review rules.
7. Money Forward posting starts only for `ready` rows.

The cutover boundary is durable. It applies to every future PDF, not only the first one. If a later PDF includes old history again, rows at or before the boundary are cut before posting decisions are made.

### Cutover Configuration

Store cutover per Suica card:

```sql
CREATE TABLE suica_card_settings (
  card_suffix TEXT PRIMARY KEY,
  last_posted_fingerprint TEXT,
  last_entered_date TEXT,
  last_entered_amount INTEGER,
  last_entered_balance_after INTEGER,
  cutover_date TEXT,
  cutover_fingerprint TEXT,
  cutover_balance_after INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Recommended rule:

```text
If cutover_fingerprint is set:
  post only rows that appear after that fingerprint in the parsed chronological sequence.

Else if cutover_date is set:
  post only rows after that date.
  Rows on the same date should default to needs_review unless the user chose
  "post entire date".
```

Using `cutover_fingerprint` is safer than using only a date because Suica PDFs can contain multiple transactions on the same day.

### Future PDFs With Old Rows

Every parse run should apply this order:

1. Parse all rows.
2. Compute fingerprints.
3. Insert or update D1 rows.
4. Apply card-level cutover.
5. For rows at or before cutover, set `before_cutover` unless they are already `posted`, `unknown`, `ignored`, or `already_entered`.
6. For rows after cutover, apply duplicate and review rules.
7. Queue only rows in `ready`.

This means the user may send overlapping PDFs. Old rows are retained in D1 for audit and balance-chain context, but they will not be posted.

### Why Not Search Money Forward

Searching Money Forward can be useful as a human aid, but it must not be the primary duplicate rule.

Reasons:

- User may have edited `物販` into a real shop or item name.
- Category may have changed.
- Amount and date can collide with unrelated Suica transactions.
- Transfers and expenses may be displayed differently from how Browser Run posts them.
- Money Forward UI selectors and search behavior may change.

If implemented, MF search should only produce suggestions such as "possible existing entry". The user or cutover rule still decides whether a PDF row is `already_entered`.

### Balance-Based Initial Consistency

For the first import, use the PDF balance sequence to check parser correctness and to choose a cutover point.

For every adjacent PDF row:

```text
previous_balance + signed_amount = current_balance
```

If the chain is valid after the chosen cutover, the automation can safely post those later rows. If it is invalid, mark affected rows as `needs_review`.

Money Forward's current Suica wallet balance may be used as an additional manual check, but it is not always reliable because:

- Existing manual entries may be incomplete.
- Charges may have been entered as income instead of transfer.
- Some expenses may have been edited or deleted.
- The wallet balance may include transactions outside the latest PDF range.

Therefore, the required initial safety gate is the local cutover decision, not automatic reconciliation against MF.

## Balance Consistency Checks

Use Suica balance as an additional parser and duplicate safety check.

For adjacent rows in the same card history:

```text
previous_balance + signed_amount = current_balance
```

Because signed amount is positive for charge and negative for spending, the balance chain should be consistent. If it is not consistent, mark affected rows as `needs_review` instead of posting.

This check catches:

- Misparsed amount.
- Misparsed balance.
- Missing row.
- Wrong year or ordering issue.

## Money Forward Account Model

Suica should be treated as a Money Forward wallet account.

Spending rows reduce the Suica wallet balance. Charge rows are transfers into the Suica wallet. Charge rows must not be posted as income.

Expected mapping:

```text
Suica transport spending:
  from Suica wallet
  expense category: transport

Suica merchandise spending:
  from Suica wallet
  expense category: configurable or review-needed

Credit card charge:
  provisional mode: transfer from cash wallet to Suica wallet
  final reconciliation with card statements is handled manually in Money Forward

Cash charge:
  transfer from cash wallet to Suica wallet
```

Because charge routes can vary, the initial automated behavior should be controlled by configuration:

```text
charge_mode = manual
  Charge rows are needs_review or ignored.

charge_mode = provisional_cash
  All positive charge rows are posted as transfer from cash to Suica.
  The user may later edit the transfer source in Money Forward.

charge_mode = review
  Charge rows appear in the review UI, and the user chooses cash/card/ignore.
```

`provisional_cash` is acceptable as a practical temporary model because it keeps charges as transfers and preserves the Suica wallet balance, while avoiding the false accounting effect of recording charges as income.

Do not automatically post `カード モバイル` rows as transfers from a real credit card account, even if the likely card is known. For cards such as PayPay Card, Money Forward may later import the actual card statement. The card statement and the Suica charge need to be matched or adjusted in Money Forward, and premature automatic card-source selection can create confusing duplicates or reconciliation work. Provisional cash keeps the Suica balance usable while leaving card reconciliation to the user.

## PDF Input Methods

There are multiple possible ways for the user to provide Suica PDFs. The input method should minimize friction while keeping duplicate prevention and cutover behavior deterministic.

### Option A: Authenticated Upload Page

The system provides a small web page where the user uploads one or more PDFs.

Pros:

- Easier to validate before accepting.
- Can show parsed preview immediately.
- Good for initial cutover and troubleshooting.
- Does not depend on email delivery.
- Matches the preferred user workflow.

Cons:

- Requires authentication.
- Needs upload size handling and CSRF protection.

Recommended use:

```text
Primary production input method.
```

### Option B: Email Attachment

The user emails the Suica PDF to a dedicated address handled by a Cloudflare Email Worker.

Pros:

- Natural periodic workflow from mobile or desktop.
- Works well with Cloudflare Workers.
- The email itself becomes an audit trail.

Cons:

- Need Cloudflare Email Routing and a domain.
- Attachment parsing and PDF validation are required.
- Bad or unrelated attachments must be rejected safely.

Recommended use:

```text
Not preferred for this project. Keep only as a possible future fallback.
```

### Option C: Token-Protected Upload URL

The system exposes a temporary or token-protected Worker upload URL. The user uploads the PDF through the Worker.

Pros:

- Secure and simple for occasional use.
- Avoids building a full login system at first.
- Good for manual one-off imports.

Cons:

- URL issuing flow is needed.
- Less convenient for periodic use.
- Not as natural as email.

Recommended use:

```text
Useful early MVP or fallback path.
```

### Option D: Manual Paste Of Extracted Text

The user copies text from the PDF and pastes it into a form.

Pros:

- Avoids PDF parsing complexity.
- Useful as an emergency fallback if a PDF parser fails.

Cons:

- Error-prone.
- Loses original PDF audit trail unless the PDF is also stored.
- Copy order may differ by PDF viewer.

Recommended use:

```text
Debug/fallback only.
```

### Option E: Local CLI Upload

A local command uploads a PDF file to the Worker endpoint.

Pros:

- Easy for development.
- Good for automated tests and fixture replay.
- Can be used without email setup.

Cons:

- Not friendly for regular mobile workflow.
- Requires local environment and token handling.

Recommended use:

```text
Development and testing.
```

### Recommended PDF Input Strategy

Use two input paths:

```text
Production:
  Authenticated upload page.

Admin/recovery:
  Token-protected upload URL or local CLI.
```

Every accepted PDF must go through the same processing pipeline:

1. Parse rows from the uploaded PDF bytes.
2. Create a PDF ingestion record in D1.
3. Compute row fingerprints.
4. Apply card-level cutover.
5. Apply duplicate and review rules.
6. Queue only postable spending rows.

## Money Forward Posting Methods

There are multiple possible ways to input parsed Suica rows into Money Forward. The implementation should start with the safest method, then add more exact methods only after Browser Run behavior is verified.

### Option A: Manual Expense Entry To Suica Wallet

Use Money Forward's manual entry UI to create each spending row as an expense from the Suica wallet.

Good for:

- Transport spending.
- Merchandise spending.
- Simple first implementation.

Pros:

- Closest to the existing ANA Pay sample.
- Easy to implement with Browser Run and CSS selectors.
- Each PDF row maps to one Money Forward row.
- Duplicate prevention can be fully controlled by the local D1 ledger.

Cons:

- Charge rows cannot be represented correctly as transfers.
- Money Forward wallet balance will drift unless charge rows are also handled.
- Category and content may need later manual editing, especially `物販`.

Recommended use:

```text
Initial MVP for spending rows only.
Charge rows remain needs_review or ignored.
```

### Option B: Manual Expense Entry Plus Manual Transfer Entry

Post spending rows as expenses and charge rows as transfers into the Suica wallet.

Good for:

- Correct Suica wallet balance.
- Credit card or cash charge rows.

Pros:

- Better accounting model.
- Suica wallet balance can match the PDF balance.
- Avoids treating charges as income.

Cons:

- Transfer UI is likely different from expense UI.
- Credit card charge source may be ambiguous and should not be auto-selected.
- Failed transfer posting has the same duplicate risk as expense posting.
- Needs more Browser Run selectors and stronger confirmation checks.
- If provisional cash mode is used, Money Forward may later need manual reconciliation with imported card statements.

Recommended use:

```text
Optional. Use only when charge_mode is provisional_cash or review.
```

### Option C: Import Through Money Forward Bulk/CSV UI

Generate a CSV or import file and upload it through Money Forward if the target account supports import.

Good for:

- Batch posting many rows.
- Human review before import.

Pros:

- Fewer browser interactions than one-by-one form input.
- User can inspect the generated file before import.
- May reduce Browser Run time.

Cons:

- Money Forward may not support the needed import path for wallet transactions.
- Import format and UI may change.
- Harder to map imported rows back to exact success/failure per PDF row.
- A failed or partially successful import creates difficult duplicate handling.

Recommended use:

```text
Do not use for MVP. Consider only if Money Forward provides a stable import UI
for wallet expenses and transfers.
```

### Option D: Review UI First, Then Browser Run Posts Approved Rows

The system creates a local review queue. The user approves rows, edits labels/categories if needed, then Browser Run posts only approved rows.

Good for:

- Merchandise rows.
- Initial cutover.
- Charge rows with ambiguous source.
- Unknown posting recovery.

Pros:

- Highest control before MF input.
- Avoids posting vague `物販` rows if the user wants richer labels.
- Useful for first import and troubleshooting.
- Keeps duplicate prevention local and explicit.

Cons:

- More UI work.
- Less automatic.
- Requires the user to visit the review screen.

Recommended use:

```text
Use review UI for initial cutover, charges, parser uncertainty, and optionally
merchandise rows. Transport rows can bypass review after the parser is trusted.
```

### Option E: Browser-Assisted Semi-Automatic Entry

Open Money Forward with Browser Run or a local browser and prefill forms, but require the user to click final submit.

Good for:

- Early testing.
- Reducing the risk of silent double posting.
- Debugging selector changes.

Pros:

- User sees exactly what will be entered.
- Safer while MF UI automation is immature.
- Useful fallback when Browser Run confirmation is unreliable.

Cons:

- Not fully automatic.
- Harder to run unattended from emailed PDFs.
- Requires a human in the loop for every batch or row.

Recommended use:

```text
Development/debug mode only, or fallback for rows marked unknown/needs_review.
```

### Recommended Input Strategy

Use a phased strategy:

```text
Phase 1:
  Parser + D1 ledger + review UI + expense-only Browser Run posting.
  Auto-post transport spending after cutover.
  Keep charges as needs_review.
  Merchandise can be either auto-posted with generic labels or held for review.

Phase 2:
  Add transfer posting for charge rows if charge_mode is provisional_cash or review.
  Verify Suica wallet balance against PDF balance after each batch.

Phase 3:
  Add optional richer review/editing for merchandise before posting.
  Add diagnostics for posted/unknown rows.
```

The default production path should be Option A plus Option D. Option B can be enabled for provisional cash transfers after expense posting is stable.

Do not use any input method that bypasses the local D1 ledger. Even if Money Forward provides an import UI, every row must still be represented locally with a fingerprint and posting status before import.

## Browser Run Posting Adapter

The first Browser Run implementation is an adapter around a Puppeteer-compatible
`page` object. It accepts parsed rows, builds Money Forward expense payloads for
`ready` spending rows, and leaves charge rows as review/transfer work.

Initial behavior:

```text
ready expense rows
  Build a manual expense payload:
    date = Suica transaction_date
    amount = abs(signed_amount)
    account = SUICA wallet
    content = parser mf_content
    category = traffic or uncategorized
    memo = suica-fingerprint:<fingerprint>

charge rows
  Do not post as income.
  Keep needs_review until transfer posting is implemented.
```

Posting result rules:

```text
posted
  The submit action completed and a success signal or navigation was observed.
  The ledger may advance last_posted_fingerprint to this row.

unknown
  The submit action was clicked, but success confirmation failed.
  Do not advance last_posted_fingerprint.
  Do not auto-retry.

failed
  Failure happened before clicking submit.
  Safe to retry.
```

The Money Forward DOM selectors are configurable. Production setup must verify
selectors against the current Money Forward UI before enabling `dryRun: false`.
The Cloudflare Worker entrypoint is `src/worker-browser-run.mjs`; local tests use
a fake Puppeteer page so duplicate-safety behavior can be verified without
touching Money Forward.

The Money Forward login/OTP handling follows the same pattern as
`windymelt/cloudflare-ana-pay-forwarder`:

```text
MF login:
  Open https://ssnb.x.moneyforward.com/users/sign_in
  Fill email/password from Worker secrets.

2FA:
  A separate Email Worker receives Money Forward OTP mail.
  It extracts "認証コード：" and stores the code in KV as suica-mf-vericode.
  The Browser Run consumer polls KV while keeping the browser session alive.
  Once a code is read, delete it from KV and submit the verification form.
  The Email Worker must also forward every received email to the user's normal
  mailbox so Email Routing does not swallow unrelated mail.
```

The current implementation stores OTP in `SUICA_MF_KV` with a 10 minute TTL.
If OTP is not received before timeout, the batch should fail before posting any
new Money Forward entries.

Set `FORWARD_TO_EMAIL` on the Worker. OTP extraction/storage is best effort, but
forwarding is mandatory; if `FORWARD_TO_EMAIL` is missing the Worker throws
instead of silently accepting and dropping mail.

Example deployment values:

```text
Domain: example.com
Route address: mf-otp@example.com
Forward-to mailbox: owner@example.com
Worker action: suica-mf-forwarder
```

The route can be created with:

```bash
CF_API_TOKEN=... npm run setup:email-routing
```

The API token must come from an environment variable and must not be committed
or pasted into scripts.

## Manual Edits in Money Forward

The user may edit Money Forward entries after posting, especially merchandise rows shown as `物販`.

This is allowed. The system must not try to reconcile by comparing current Money Forward content back to the PDF row.

The durable link is:

```text
Suica PDF row fingerprint -> local D1 status
```

If Money Forward entry IDs can be captured, store them for diagnostics, but do not require them for duplicate prevention.

## Review Policy

Recommended initial policy:

```text
Transport rows:
  auto-post if balance chain is valid.

Merchandise rows:
  either auto-post with generic content, or mark needs_review.
  Even if auto-posted, later MF edits are safe because duplicate detection is local.

Charge rows:
  manual mode: ignored or needs_review.
  provisional_cash mode: ready as transfer from cash to Suica.
  Never auto-post as income.

Parser confidence issues:
  needs_review.

Unknown posting result:
  unknown, never auto-retry.
```

## Security Notes

- Store Money Forward credentials as Workers secrets.
- Do not persist original PDFs unless there is a specific retention requirement.
- Do not log raw full PDFs.
- Avoid logging Money Forward password or verification code.
- Keep Browser Run automation scoped to Money Forward.

## Implementation Order

1. Build a local parser test using sample Suica PDFs and expected JSON fixtures.
2. Implement Worker-compatible PDF parsing with `pdfjs-dist`.
3. Add D1 schema and fingerprint insertion.
4. Add parser Queue consumer.
5. Adapt the existing ANA Pay Money Forward consumer to Suica wallet entries.
6. Add posting statuses, especially `unknown`.
7. Add a minimal review UI for `needs_review` and `unknown`.
8. Add Browser Run screenshots or HTML snapshots for posting diagnostics.
