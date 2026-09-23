# Additional Billy workflows (v0.2)

Read only the relevant section. Confirm the installed tool schemas; version 0.1 clients do not have these batch/report tools. New sales, credit-note, partial-FX and fee paths are fixture tested, not live-verified by the release. An economical executor must not turn a routine request into an unrequested first live test. Use the deployment's recorded acceptance evidence and existing user scope.

## One approval for an ordered purchase batch

Collect and import all originals first; validate each document and live supplier/account/tax mapping. Prepare 1–10 cases with `billy_batch_prepare`:

```json
{
  "reason":"<verified documents and user's authorized stages>",
  "cases":[{
    "receiptId":"<archived original hash>",
    "bill":{
      "contactId":"<supplier ID>","entryDate":"<invoice date>","currencyId":"<currency>",
      "suppliersInvoiceNo":"<original invoice number>","taxMode":"excl",
      "lines":[{"accountId":"<expense account>","taxRateId":"<tax ID>","description":"<service>","amount":100}]
    },
    "approve":true,
    "reconcile":false
  }]
}
```

The amount is illustrative. Supply actual evidence. `approve:false` stops at a draft. To record payment add `payment` containing the exact observed bank line's `bankLineId`, `entryDate`, `cashAccountId`, `cashSide` and `cashAmount`, plus any supported explicit FX evidence. Payment needs `approve:true`; reconciliation needs a payment and `reconcile:true`. Never add unrequested stages.

Inspect the returned full ordered `spec`, `id`, `hash` and evidence. Call `billy_batch_execute({batchId:id,expectedHash:hash,authorization:<factual user-scope note>})`. The configured client form approves the complete batch once. The server binds dependent bill and payment IDs itself, verifies each stage and records durable progress. It prevents another process from inserting writes while the batch is running.

Inspect `billy_batch_get({batchId})`, its status and child plan IDs. A stopped result is partial completion, never a failed transaction that can simply be repeated from scratch. Inspect the reason and journal before resuming the same ID/hash. Completed stages are reused. An unknown/executing child stops all company writes; operator recovery remains a separate investigation. An unstarted batch can be refreshed with `billy_batch_refresh`; this requires approval of the new hash. After partial completion, changed evidence requires a newly reviewed scope for unfinished work, reusing existing completed bills and payments through individual operations where necessary.

## Sales invoice draft, approval and send

Use `billy_prepare` with `kind:"create_sales_invoice"`, existing customer `contactId`, date, currency, taxMode, expected net/VAT/total and lines with productId, salesTaxRulesetId, expectedTaxRateId, quantity and unitPrice. Get those tax IDs from the current product/rules, not a company-number convention. The server creates and verifies a draft.

For a draft correction, `update_draft_invoice` accepts only id, reviewed totals and the documented header fields contactMessage, taxMode or paymentTermsDays. It cannot change invoice lines. Do not simulate a correction by issuing an additional invoice.

Prepare `approve` for resource `invoices` only within scope. Sending requires a separate `send_invoice` operation with invoice id, contactPersonId, exact recipientEmail, emailSubject and emailBody. Verify that the contact person belongs to the customer and that sending was explicitly authorized. An unconfirmed send result is unknown: inspect Billy, do not send again.

## Credit notes

Read the approved original with embedded lines and list existing credits. A customer credit uses `create_customer_credit_note` with originalInvoiceId, date, expected net/VAT/gross and positive original-linked lines. Each line includes originalLineId and matching product/tax evidence. The allowed quantity and amount cannot exceed the original after previous credits.

A supplier credit uses its own original document. Import it with metadata `documentType:"creditNote"`, `creditedInvoiceNumber` matching the original invoice, the credit's own invoiceNumber/date and positive net/VAT/gross. Upload it, then prepare `create_supplier_credit_note` with receiptId, originalBillId, entryDate, expected totals and original-linked lines containing originalLineId, accountId, taxRateId, description and positive amount. The draft must retain the original credit attachment.

Approval is separate. A credit note is not a refund, bank match or proof that the original invoice's balance is settled. Credit-note application/refund settlement is not implemented.

## Partial payments and explicit fees

Use the ordinary exact-bank-line recipe. Same-currency partial payments reduce the balance by the verified subject amount and leave the remainder unpaid. For supported supplier FX payments, explicitly provide subjectAmount in the bill's currency, subjectCurrencyId and cashExchangeRate. The bank account must use the company's base currency. If cent rounding makes the original liability allocation ambiguous, preflight rejects it; report the exception without adjusting the evidence to fit.

A evidenced fee uses feeAmount, feeAccountId and subjectAmount. Verify the fee from the bank/provider evidence; a currency difference alone is not a fee. Fee-bearing payments require a base-currency bank account. Supplier outflows include the fee in cashAmount; customer receipts are net of it. After execution, verify balance reduction, association and bank/liability/fee/FX postings. A partial payment never justifies reporting the invoice as fully paid.

## Reports

- `billy_trial_balance({asOf:"YYYY-MM-DD"})` gives base-currency account balances through that date. `accountIds` narrows the scope.
- `billy_profit_loss({start,end})` uses the live income-statement classification; explicit revenueAccountIds and expenseAccountIds can select a reviewed subset.
- `billy_period_expenses({start,end})` sums expense postings, including reducing credits.
- `billy_outstanding({})` reports current unpaid approved bills/invoices and separate credit notes, grouped by original currency.

Use returned scope and completeness fields. Reports use current void state; they cannot reconstruct a historical snapshot. Never sum different original currencies. Missing FX base amounts are an explicit exception, not zero. None of these tools files or settles VAT.
