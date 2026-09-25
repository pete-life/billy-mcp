# Billy MCP

A local MCP server for Billy bookkeeping: complete accounting reads, receipt collection/provenance, reviewed purchase and sales drafts, credit notes, payments, reports and reconciliation of existing bank postings. Generic company support: **the API token determines the company**. This is an independent community project, not an official Billy or Shine product.

## Run

Version 0.2.1 is distributed as an installable tarball on [GitHub Releases](https://github.com/pete-life/billy-mcp/releases/tag/v0.2.1). The scoped package is also published on npm as `@pete-life/billy-mcp@0.2.1`. Use `npm install -g @pete-life/billy-mcp@0.2.1`, the release tarball or the repository build below; see [installation and agent setup](docs/installation.md).

Requires Node.js 22.13+ (built-in SQLite).

```sh
git clone https://github.com/pete-life/billy-mcp.git
cd billy-mcp
npm ci --ignore-scripts
npm run build
npm run setup
npm start
```

Create a company API token in Billy under Settings → Access tokens. Setup asks for it with hidden terminal input, fetches the connected company and asks you to confirm that identity. It writes an owner-readable `credentials.env` outside the repository, under `~/.local/share/billy-mcp/`. Do not paste tokens in chat. `npm start` loads that file automatically.

Alternatively set `BILLY_ACCESS_TOKEN` in the MCP process environment. The company ID is discovered automatically. `BILLY_ORGANIZATION_ID` is optional: set it to enforce an expected company in addition to the token. A mismatched token is rejected. Setup records this extra guard automatically.

Each company has separate local receipt metadata, plans and vendor registry rows. Use a different `BILLY_DATA_DIR` for fully separate account profiles. Do not share a profile directory across machines or network filesystems; execution locking is local SQLite.

Generic MCP client configuration for this checkout:

```json
{
  "mcpServers": {
    "billy": {
      "command": "node",
      "args": ["/absolute/path/to/billy-mcp/dist/launch.js"]
    }
  }
}
```

`command` must resolve to Node 22.13+ in your desktop client's environment; an absolute Node path is safest. This file is a configuration example, not an automatic edit to your client settings.

## Included tools

| Tool | Purpose |
|---|---|
| `billy_status` | Connected company, write switches and receipt inbox |
| `billy_list` / `billy_get` | Typed resource selection, supported filters, full pagination |
| `billy_period_overview` | Unreconciled bank lines, possible existing postings and receipts |
| `billy_trial_balance` / `billy_profit_loss` | Account balances and period profit/loss using the live chart |
| `billy_outstanding` / `billy_period_expenses` | Current unpaid documents and period expense totals |
| `billy_import_receipt` / `billy_receipts` | Archive originals, deduplicate bytes and retain provenance |
| `billy_save_vendor` / `billy_vendors` | Vendor billing accounts and retrieval/access status |
| `billy_prepare` | Preview a concrete financial operation and current record snapshots |
| `billy_plan` / `billy_refresh_plan` | Inspect or refresh an unexecuted proposal |
| `billy_execute` | Execute a reviewed proposal once, then read back the outcome |
| `billy_journal` | Inspect completed, rejected and uncertain operations |
| `billy_batch_prepare` / `billy_batch_get` | Preflight and inspect 1–10 ordered purchase cases |
| `billy_batch_refresh` / `billy_batch_execute` | Refresh unstarted scope, approve once and resume guarded stages |

Read tools default to compact, sanitized responses. Lists return `{records,count,complete}`; individual reads return `{record,complete}`. Use `verbose:true` for additional sanitized fields. Every record is retained; compact output does not truncate rows or change internal verification snapshots.

The `bookkeeping-period` MCP prompt loads the [bookkeeping skill](skills/billy-bookkeeping/SKILL.md). It orchestrates Gmail/Drive/local files/**vendor portals** through the agent's existing connectors and browser tools. Those external tools and logged-in sessions are not bundled in this MCP server. Original files are downloaded into the configured inbox, read by the agent and imported with source and extracted invoice metadata. This project does not contain a universal authenticated vendor scraper or built-in OCR.

## Reusable bookkeeping skill

The [bookkeeping skill](skills/billy-bookkeeping/SKILL.md) contains tool recipes, exception handling and an optional learning routine. The MCP prompt loads the same file. To use it directly in a skill-aware client, install or link the `skills/billy-bookkeeping` directory according to that client's instructions.

Choose your own model. Store company-specific mappings, mailbox selection and billing portal access outside the public repository. External mail, file and browser tools must be supplied by the calling agent.

The learning routine records evidence privately under the configured data directory. Any reusable public documentation change must exclude company records and secrets. Learning does not authorize additional accounting actions.

## Supported operations

`billy_prepare` accepts a validated discriminated operation:

- `upload_receipt`: upload an archived PDF/PNG/JPEG and confirm the attachment exists.
- `create_contact`: create a customer/supplier with duplicate name/registration checks.
- `create_bill`: create a **draft**, using an uploaded receipt, supplier, invoice date/number, currency, explicit tax mode and account/tax-coded lines. Supplier name and extracted totals must match.
- `create_journal`: create a balanced **draft**, with receipt or explicit no-receipt reason plus bank-line identity. Tax-coded journal expansion is not live-verified; use a purchase bill for VAT-coded expenses.
- `approve`: approve a reviewed bill, invoice or journal draft. Bills require attached evidence.
- `create_sales_invoice` / `update_draft_invoice`: create a reviewed sales draft or edit its documented header fields. Invoice lines cannot be replaced after creation.
- `send_invoice`: send an approved sales invoice to one reviewed contact-person email in a separate operation.
- `create_customer_credit_note` / `create_supplier_credit_note`: create an original-linked, amount-limited draft credit note. Supplier credits require their original credit document.
- `create_payment`: register full/partial same-currency payments, supported supplier FX settlements and evidenced fees against an exact unused bank line. Fee-bearing payments require a base-currency cash account; ambiguous FX rounding is rejected before writing. This records money already moved, not a bank transfer.
- `reconcile`: associate one bank line's existing match with an existing bank-account posting and approve it. No expense is created. This is separately gated and live-verified for the documented single-line DKK flow.

See [operation contracts and limitations](docs/operations.md) for required evidence, supported currency combinations and verification status. [Purchase batches](docs/batches.md) execute original upload, draft, optional approval, payment and reconciliation with persistent per-stage progress.

## Execution guarantees and limits

Writes are off by default. To enable them after setup/acceptance, set `BILLY_ALLOW_WRITES=true` in the local credentials file or process environment. This enables the capability; it does not authorize arbitrary financial actions. Default `BILLY_APPROVAL_MODE=confirm` requires a user-facing MCP form approving the exact single operation or complete batch. Unsupported clients, decline and cancellation fail closed. An operator can explicitly choose `BILLY_APPROVAL_MODE=trusted_automation` in their private local profile for authorized automation. The `authorization` text remains an audit note, never proof of consent. See [approval modes](docs/batches.md).

Each preview has a persisted ID and hash binding the operation **and the current records**. Execution claims a company-wide SQLite lock, validates fresh data, writes and reads back. Repeated execution returns stored evidence. Another changed request is still another operation: callers must not use different wording/amounts to bypass an uncertain write.

- No POST/PUT automatic retries. Read-only 429/temporary server errors have bounded retries and a timeout.
- A crash, timeout, malformed response or failed verification after sending a write is **unknown**, never “failed, safe to retry”. Unknown/executing plans block subsequent writes for that company. A definitive first-write 400/401/403/404/409/422/429 rejection is retryable only after a fresh preview. Recovery of genuinely uncertain writes requires operator investigation against Billy and the interactive local command described below.
- Preview expires after 30 minutes; changed data requires refreshing and reviewing the new hash.
- Receipt import restricts paths to the configured inbox, rejects escaping symlinks, checks PDF/PNG/JPEG signatures and limits size to 20 MB. SHA-256 identifies the original bytes. It does not prove invoice validity or correct extraction.
- Duplicate bill checks compare invoice references across contacts with matching name/registration number, plus same-date/amount candidates. They cannot prove uniqueness when existing supplier identity, references and dates are all different or missing. Inspect existing postings first; journal/payment bank-line IDs prevent local duplicate actions.
- A sequence of remote API calls is not an atomic Billy transaction. If reconciliation stops after association creation, it is unknown and must be investigated.
- Concurrent manual edits in Billy cannot be fully locked by this server. Fresh snapshots reduce but cannot eliminate that race.

## Live verification status

**Live purchase flow verified on 2026-09-22:** company-token connection, original PDF upload, attachment linking, Danish VAT purchase draft, approval and independent balanced-ledger readback were verified through the live API. Supplier legal-name changes can be matched by verified country and registration number. A same-currency DKK supplier payment and single-posting bank reconciliation were also live-verified on 2026-09-22, including independent balanced-ledger and zero-balance checks; see [live acceptance](docs/live-acceptance.md).

`BILLY_ALLOW_BANK_MATCHING` defaults to false independently of other writes. Public documentation labels match relationships read-only and does not explain the full approval sequence. The implemented single-posting sequence follows the separate documented association resource; the single-line DKK flow was subsequently live-validated; other variants remain unverified.

All four v0.2 reports completed in a GET-only live probe on 2026-09-23. The sales, credit-note, partial-FX, fee, approval and batch paths are fixture tested; they are not newly live-verified. Current exceptions include FX customer receipts and non-base-bank FX settlement, ambiguous cent allocations, grouped/split bank matches, credit-note settlement/refunds, automatic VAT filing or settlement, subscription changes, bank transfers, remote hosting, scheduling, remote batch atomicity and automatic recovery of unknown writes. Tax-coded journal expansion remains unverified.

## Operator recovery

After inspecting the real Billy records and resolving any partial operation in Billy, run:

```sh
npm run recover -- PLAN_ID applied
# Or, only after establishing that no remote changes occurred:
npm run recover -- PLAN_ID not_applied
```

This is an interactive local operator command, never an MCP tool. It requires an evidence note and confirmation of the plan ID, records the decision and never writes to Billy. It refuses recovery of an executing plan while the recorded executor process is alive. `applied` becomes a terminal state that cannot replay; `not_applied` allows a refreshed preview. Incorrect operator assertions are not detectable automatically, so inspect the entire operation first.

## Development

```sh
npm run check
```

Tests use temporary local files and simulated Billy responses. The stdio test starts the compiled MCP server and performs protocol initialization, tool discovery, validation errors and prompt retrieval. No test touches production accounting data.

Official references: [Billy API](https://www.billy.dk/api/), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x). API documentation checked 2026-09-23.

## License and contributions

MIT licensed. See [LICENSE](LICENSE). Contributions are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md). For security reports, see [SECURITY.md](SECURITY.md). This is an early release with deliberately limited accounting flows; review the supported operations and verification limits before enabling writes.
