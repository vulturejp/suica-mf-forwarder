# suica-mf-forwarder

Cloudflare Worker for parsing Mobile Suica balance PDFs and posting expense rows to Money Forward through Cloudflare Browser Rendering.

## Features

- Upload UI for Mobile Suica PDF files
- PDF validation before posting
- Cutover support by last entered date, amount, balance, or saved fingerprint
- Money Forward posting with a single browser session per run
- Balance reconciliation during posting
- Browser usage budget guard for Cloudflare's daily limit
- OTP email receiver for Money Forward verification codes
- Email forwarding so Cloudflare Email Routing does not swallow normal mail

## Setup

Copy `wrangler.example.toml` to `wrangler.toml` and replace the placeholder values. Do not commit `wrangler.toml`.

Required Worker secrets:

```bash
wrangler secret put MF_EMAIL
wrangler secret put MF_PASSWORD
wrangler secret put UPLOAD_AUTH_TOKEN
```

Important vars:

- `ACCESS_ALLOWED_EMAIL`: Cloudflare Access authenticated email allowed to use the upload UI
- `FORWARD_TO_EMAIL`: mailbox that receives forwarded OTP/routed email
- `MF_SUICA_ACCOUNT_DETAIL_URL`: Money Forward manual SUICA account page URL
- `MF_MANUAL_EXPENSE_URL`: Money Forward manual entry page URL, usually the same manual account page
- `MF_SUICA_ACCOUNT_NAME`: account label, default `SUICA`

For local parser tests with a real PDF:

```bash
SAMPLE_SUICA_PDF=/path/to/mobile-suica.pdf npm test
```

Without `SAMPLE_SUICA_PDF`, PDF fixture-dependent tests are skipped.

## Cloudflare Helpers

Email Routing setup:

```bash
CF_API_TOKEN=... \
CF_ACCOUNT_ID=... \
CF_ZONE_NAME=example.com \
EMAIL_ROUTE_ADDRESS=mf-otp@example.com \
FORWARD_TO_EMAIL=owner@example.com \
npm run setup:email-routing
```

Cloudflare Access setup:

```bash
CF_API_TOKEN=... \
CF_ACCOUNT_ID=... \
ACCESS_APP_DOMAIN=suica-mf-forwarder.example.workers.dev \
ACCESS_ALLOWED_EMAIL=owner@example.com \
npm run setup:access
```
