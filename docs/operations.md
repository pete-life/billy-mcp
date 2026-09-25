# Accounting operations and verification limits

All writes use `billy_prepare` → review its persisted `id` and `hash` → `billy_execute`. Default execution requires a client approval form. An authorization string is an audit note, not consent. Purchase batches use [one approval for their complete ordered scope](batches.md). Read-only reports do not need write capability.

## Sales invoices

- `create_sales_invoice` creates a draft for an existing customer. Each line supplies `productId`, the product's current `salesTaxRulesetId`, an `expectedTaxRateId`, quantity and unit price. Supply expected net, VAT and total amounts. The server checks the live product and tax rules, then verifies the resulting lines and totals.
- `update_draft_invoice` edits the documented header fields `contactMessage`, `taxMode` or `paymentTermsDays` on an ordinary draft. Expected totals are required. Billy documents invoice lines as immutable after creation; this operation cannot replace them.
- `approve` approves a reviewed draft. Creating, approving and sending are separate operations.
- `send_invoice` requires an approved ordinary invoice, its current customer contact-person ID, the exact reviewed recipient email, email subject and body. This is an outbound email and requires explicit sending scope. A successful HTTP response alone is insufficient: if the subsequent invoice read does not confirm a sent state, the plan becomes unknown. Inspect Billy before any retry.

## Credit notes

`create_customer_credit_note` references an approved original via `originalInvoiceId`; each positive credit line includes `originalLineId` and the original product, tax, price and quantity evidence. Expected net/VAT/total amounts and cumulative previous credits prevent an excessive credit. Ambiguous original lines are rejected. The result is a draft credit note, not a refund or outgoing email.

`create_supplier_credit_note` requires a separately imported and uploaded original credit document. Its receipt metadata must contain `documentType:"creditNote"` and `creditedInvoiceNumber` matching the original bill. Supply `originalBillId`, document date, original line IDs, matching account/tax IDs, positive credit amounts and expected totals. Supplier identity, currency, receipt arithmetic, duplicate document numbers and prior credits are checked. The credit document is attached to the new draft. Ordinary invoices must not be imported as credit notes.

The ordinary `approve` operation can approve a reviewed credit draft. Payment/refund settlement and applying a credit against another document are not implemented.

## Payments, partial settlements and fees

A payment records an observed bank movement. It never transfers money. Every payment identifies one exact unused bank line, cash account, date, direction and amount, and an approved bill/invoice with a sufficient outstanding balance.

Same-currency partial payments are supported. For FX, supply `subjectAmount`, `subjectCurrencyId` and `cashExchangeRate` in cash-account units per subject-currency unit. FX currently supports supplier bills from a base-currency cash account. Where cent rounding makes the original liability allocation ambiguous, preflight rejects the operation. Do not change the amount or omit FX fields to bypass it.

Explicit payment-provider or bank fees require `feeAmount`, `feeAccountId` and `subjectAmount`. The fee must be evidenced separately from the exchange-rate difference. Fee-bearing payments require a base-currency cash account. For supplier outflows, the bank debit includes the fee; for customer receipts, the bank credit is net of the fee. The server checks cash, subject balance, associations and applicable liability, fee and FX ledger postings after writing.

`reconcile` still supports one unapproved bank-line match against one existing matching bank-account posting. Grouped/split matches, refunds, credit-note settlements and foreign sales-invoice payments are outside the supported contract.

## Reports

- `billy_trial_balance`: current non-voided postings through `asOf`; optional explicit account subset.
- `billy_profit_loss`: inclusive `start`/`end`, classified using the live chart's `accountGroups` and `accountNatures` (`incomeStatement` by default), or explicit revenue and expense account IDs.
- `billy_period_expenses`: net postings on debit-normal accounts in the selected live report type.
- `billy_outstanding`: current approved unpaid document balances, kept separate by original currency. Credit notes appear separately; their polarity is not inferred.

Reports consume all pages and reapply date/state filters locally. They use base-currency cents and reject FX postings without a base amount. A report uses today's void state; it is not a historical snapshot of what was known on a past date. An explicit account subset only reports that subset. These reports do not submit or settle VAT.

## API evidence and release status

The primary contract is the [Billy API reference](https://www.billy.dk/api/), checked 2026-09-23. Supplier credit-note fields are documented there, while the `creditNote` bill type additionally appears in a [published Billy integration schema](https://github.com/CloudElementsOpenLabs/elements/blob/9327e3d1341064df28795437d9b83075d2f276e3/billyaccounting/swagger-pretty.json). That older integration schema is supporting evidence, not a live acceptance result.

The new sales, credit-note, partial-FX, fee, approval and batch paths have synthetic contract/integration tests. No live financial write or email was made while implementing this version. Existing live acceptance evidence applies only to the flows listed in [live acceptance](live-acceptance.md). A first live use of an additional flow should be a separately authorized, independently verified acceptance case.


### Draft payment terms and snapshot stability

`update_draft_invoice.paymentTermsDays` means net calendar days from the existing invoice date. The writer sets `paymentTermsMode:net` together with the day count and checks the returned due date, totals, draft state and unchanged lines. It does not approve or send the invoice. A wrong post-write due date is an unknown outcome, never an automatic retry.

Invoice snapshots exclude only the top-level `downloadUrl`, which Billy can regenerate on every read. All other fields remain covered by the comparison, including unknown fields. Old unexecuted/rejected plans containing the link need an explicit refresh and review before execution; do not alter completed or unknown plans. For repeated pre-write drift rejection, inspect and refresh once, then return the unresolved case for investigation instead of looping.

Net-term updates are fixture-tested; deployment-specific live acceptance must separately confirm that Billy recalculates dueDate when changing from date to net. Read the private deployment profile for that evidence.
