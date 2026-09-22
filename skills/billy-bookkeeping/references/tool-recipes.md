# Billy MCP tool recipes

Use the selected operation only. Parameter names below match the tested local server; use live schemas if the installed version differs. Text in `<...>` denotes a value obtained from the document or previous tool response, never a literal ID to send.

## Exact common read calls

| Tool | Arguments |
|---|---|
| `billy_status` | `{}` |
| `billy_vendors` | `{}` |
| `billy_receipts` | `{}` |
| `billy_journal` | `{}` |
| `billy_plan` | `{"planId":"<existing UUID>"}` |
| `billy_list` | `{"resource":"bills","filters":{"suppliersInvoiceNo":"<original number>"}}` |
| `billy_get` | `{"resource":"bills","id":"<existing bill ID>","include":"bill.lines:embed"}` |
| `billy_period_overview` | `{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}` |

There is no companyId parameter on these tools. Reporting and learning-log writes use ordinary output/local file tools, not invented Billy tools. For a task about an already-completed run, only inspect existing evidence and save learning; never create a new receipt or financial plan.

## Collect originals

### Email

Use the company's connected account explicitly. For a multi-account connector, explicitly select the verified company mailbox. Search with GMAIL_FETCH_EMAILS using a bounded vendor/date query. Get the attachment with GMAIL_GET_ATTACHMENT using message_id, attachment_id and file_name. Read connector schemas if needed; don't guess a tool or its parameters.

Large responses may contain `storedInFile:true` and `outputFilePath` instead of the messages. Read that saved result, select message metadata and attachment identifiers, and avoid dumping entire MIME payloads. A downloaded original may be returned as a file URL; use the connector's supported download mechanism. Copy it to `receiptInbox` from `billy_status`, read the PDF/image and retain the original bytes. Do not print or save signed download URLs as provenance. Use stable message/attachment IDs.

### Vendor portals

1. Check `billy_vendors` and the correct company/account. Prefer an available official API or connector, otherwise use the installed browser skill and existing signed-in session.
2. Navigate to Billing/Invoices for the requested dates and download the original invoice. No changes to subscription, payment method or account settings.
3. Use `billy_save_vendor` with id, name, clean HTTPS portalUrl, accountLabel, status and notes. A new vendor ID is a local registry key, not a Billy contact ID. Valid statuses: ready, needs_login, needs_2fa, not_accessible, not_checked.
4. Import with source `{kind:'vendor_portal',vendorId:<registry ID>,reference:<portal URL>}`. The reference must have the same origin as the saved portal; the server retains only the origin. If download is on another host, retain the portal as source, not the signed CDN URL.
5. Login/2FA or inaccessible historical invoices are exceptions. Never fabricate a receipt or mark collection complete without the downloaded original.

### Existing Billy attachment

If a verified original is already attached to an existing bill, reuse that bill and inspect its state. The current create_bill tool requires a locally imported receipt uploaded through the receipt registry. Do not upload an existing unowned Billy document again to circumvent that limitation; flag the case for linking support or manual review.

## Purchase: tested domestic invoice flow

Prerequisites: original inspected; connected company verified; correct supplier contact/current account and tax IDs; no matching existing bill; authorization covers this invoice or concrete batch.

1. Import with `billy_import_receipt`:

```json
{
  "filePath": "<absolute original path inside receiptInbox>",
  "source": {"kind":"gmail","reference":"<stable message ID>/<attachment filename>"},
  "metadata": {
    "supplier":"<legal supplier from original>",
    "supplierCountryId":"<two-letter country>",
    "supplierRegistrationNo":"<registration/VAT number from original>",
    "invoiceNumber":"<original number>",
    "invoiceDate":"<YYYY-MM-DD>",
    "currencyId":"<document currency>",
    "netAmount":345,
    "vatAmount":86.25,
    "totalAmount":431.25
  }
}
```

Numbers illustrate the known test; replace them with the actual document. Registration and country are optional only when unavailable, but never omit conflicting evidence to force a name match. Conflicting metadata on the same file requires review, not an altered copy.

2. If the returned receipt already has an attachmentId, reuse it. Otherwise call `billy_prepare` with `operation:{kind:'upload_receipt',receiptId:<returned receipt ID>}` and a factual reason. Then `billy_execute` with returned planId, expectedHash and a factual authorization note referencing the user's scope. Check `completed` and record the returned attachment.
3. Call `billy_prepare` for the draft:

```json
{
  "operation": {
    "kind":"create_bill",
    "receiptId":"<returned receipt ID>",
    "contactId":"<verified existing Billy supplier ID>",
    "entryDate":"<original invoice date>",
    "currencyId":"<document currency>",
    "suppliersInvoiceNo":"<original invoice number>",
    "taxMode":"incl",
    "lines":[{
      "accountId":"<verified expense account ID>",
      "taxRateId":"<verified tax rate ID>",
      "description":"<service and period from original>",
      "amount":431.25
    }]
  },
  "reason":"<evidence and authorized action>"
}
```

With `incl`, line amounts sum to gross; with `excl`, they sum to net. Do not mix them. Use separate lines only when their accounting/tax split is evidenced. Call execute on the exact returned plan; record the resulting bill ID.
4. `billy_get {resource:'bills',id:<bill ID>,include:'bill.lines:embed'}`. Verify draft, date, supplier, invoice number, currency, each line's account/tax ID, amount/net, tax and grossAmount. Then `billy_list {resource:'attachments',filters:{ownerReference:'bill:<bill ID>'}}` and verify the original attachment ID. The owner filter uses **ownerReference**, not ownerId.
5. If those facts match and approval is in the existing user scope, prepare `{kind:'approve',resource:'bills',id:<bill ID>}`, then execute its returned plan ID/hash. No repeat authorization question for an already-authorized single-booking request.
6. Read the bill and attachments again. Expected: approved with correct totals and original attachment. To check ledger: list postings for the invoice date; look up their transactions and select `originatorReference === 'bill:<bill ID>'`. Confirm the relevant debits and credits balance. Do not assume a transaction ID exists directly on the bill.
7. Leave payment separate. An approved supplier invoice with balance > 0 is booked and unpaid, not bank-reconciled.

## Existing cases and errors

| Observation | Next action |
|---|---|
| Matching approved bill exists | Report already booked; don't upload/create again |
| Matching draft exists | Inspect original, lines and authorization; approve that draft only if verified and in scope |
| Matching supplier CVR/country, changed legal name | Reuse supplier; import document's legal name and registration fields |
| Registration differs despite same name | Exception; no name-only workaround |
| Upload completed but bill failed preconditions | Keep uploaded receipt; fix/review the rejected proposal, no re-upload |
| Approval completed, extra GET failed with `include=lines` | Read using `bill.lines:embed`; never re-create/re-approve |
| Two equal payments on different bank lines | Preserve separate bankLineId values; amount/date is not a unique identity |
| No bank line / payment only initiated | Book verified invoice if authorized; leave unpaid |
| `unknown`/interrupted `executing` | Stop company writes, retain plan ID, escalate; do not run recovery yourself |

## Same-currency payment and one-line reconciliation

Live-tested for DKK supplier purchases; validate applicability to the connected company. Use only when the user scope includes the relevant actions and live capability status permits them. This records money already moved; it does not initiate a bank transfer.

1. Read the approved bill, exact bank line, its bank account and existing match with `bankLineMatch.lines:embed,bankLineMatch.subjectAssociations:embed`. Check company, DKK currency, date, amount, credit direction, supplier/reference and outstanding balance. Search existing bank-account postings/payments so an already-recorded movement is not paid twice. Equal amount alone is not sufficient.
2. For a new full same-currency supplier payment, prepare then execute `create_payment` with `entryDate` from the bank line, `cashAmount` equal to the observed debit, `cashSide:'credit'`, `cashAccountId` from that line, its exact `bankLineId`, and `subjectReference:'bill:<verified bill ID>'`. Preserve returned plan/payment IDs. Verify the bill's balance falls by the exact amount and isPaid becomes true for full payment.
3. Find the bank-account posting by account/date and verify its transaction has `originatorReference:'bankPayment:<returned payment ID>'`. Check amount and credit side. This identifies the actual payment posting, rather than merely another equal amount.
4. Re-read the bank-line match. This recipe requires one exact line, unapproved match and no existing subject associations. Prepare then execute `reconcile` with the exact bankLineId and `subjectReference:'posting:<verified bank posting ID>'`. The server creates the association and approves the match; it must not create another expense or payment.
5. Read back bill, payment, transaction, bank posting and match. Confirm zero bill balance/full-payment status, correct date/amount, balanced supplier-debit/bank-credit ledger, approved match, the exact single association and `isBankMatched:true` on the bank posting. The supplier-liability posting need not be bank-matched.
6. Report paid and reconciled only after these checks. Unknown or partial writes still stop execution; a completed payment followed by a rejected match is not permission to create another payment.

## Full foreign-currency supplier payment

Live-tested for a full USD supplier bill paid from a DKK base-currency bank account. Requires explicit payment scope, an untouched approved bill, and one exact unapproved bank line without existing associations. The cash account must use the company's base currency. No partial settlements, fees, grouped bills or foreign sales-invoice payments in this recipe.

Follow the payment/reconciliation checks above, with these additional `create_payment` fields: `subjectAmount` = full outstanding amount in bill currency, `subjectCurrencyId` = that currency, `cashExchangeRate` = cash-account units per one bill-currency unit. A synthetic example is subjectAmount 10 USD, cashAmount 70 DKK and rate 7. These are illustrative values, never constants for another payment. The rate must explain the actual bank debit; do not reuse the original bill's accounting rate or invent a bank fee.

The server sends Billy's documented cashExchangeRate, verifies the association's subject amount and zero bill balance, then verifies the payment's exact bank, original liability and signed currency-difference ledger postings before completing. Reconcile the resulting bank posting using the ordinary one-line recipe; do not create another expense or separate manual FX journal. An unknown outcome still stops writes.

If the active MCP session exposes the old schema, reconnect to the updated server. Never omit FX evidence to pass an older tool schema.

## Other operations

For payment/reconciliation outside the verified recipe above, read-only preparation is possible with current tool schemas. Do not execute a capability marked unverified in the deployment profile on a cheap worker's own initiative. The first live test is a separate explicitly authorized engineering task. Tax-coded journals, foreign-currency payments outside the full supplier-settlement recipe and grouped/partial bank matches are currently unsupported. Do not emulate them through a different write tool.
