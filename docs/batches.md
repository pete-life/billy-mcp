# Client approval and purchase batches

Billy MCP defaults to `BILLY_APPROVAL_MODE=confirm`. Before `billy_execute` or `billy_batch_execute` starts a financial write, the server asks the MCP client to show a form containing the company, the complete ordered scope, amounts and a SHA-256 scope hash. Only an accepted form with its approval control set to true proceeds. Decline, cancel, a client without form elicitation, or a failed elicitation stops before the write. The tool's `authorization` string is an audit note supplied by the calling agent; it is not proof of human consent.

An operator who has separately authorized a defined automation can set `BILLY_APPROVAL_MODE=trusted_automation` in the private local profile or MCP process environment. This is an explicit local trust choice, not a tool argument. `BILLY_ALLOW_WRITES=true` is still required. Both modes retain exact plan hashes, fresh-record checks, the company execution lock, and unknown-outcome stops. Setup leaves the mode at `confirm` unless the operator changes it.

## Typed purchase batch

`billy_batch_prepare` accepts 1 to 10 ordered purchase cases. Each case identifies an already archived original receipt, an existing supplier contact, the exact draft bill fields and lines, and explicit optional stages. The server checks receipt bytes and invoice metadata, supplier identity, net/VAT/gross line amounts, accounts, tax rates, duplicate invoice references, and any payment bank line before persisting the initial evidence hash. It does not write to Billy.

```json
{
  "reason": "Book the two verified September supplier invoices",
  "cases": [
    {
      "receiptId": "<64-character archived receipt hash>",
      "bill": {
        "contactId": "<existing supplier ID>",
        "entryDate": "2026-09-20",
        "currencyId": "DKK",
        "suppliersInvoiceNo": "EXAMPLE-001",
        "taxMode": "excl",
        "lines": [{"accountId": "<expense account ID>", "taxRateId": "<purchase tax ID>", "description": "Example service", "amount": 100}]
      },
      "approve": true,
      "reconcile": false
    }
  ]
}
```

The example is a shape illustration, not a valid receipt or authorization. `approve:false` leaves the bill as a draft. For payment, add `payment` with the exact bank line ID, entry date, cash account, side and amount. Supported explicit FX fields and feeAmount/feeAccountId can be included; fees require the configured bank fee account and a verified subjectAmount. A payment requires `approve:true`. Set `reconcile:true` only with a payment and only when separately enabled bank matching is appropriate. The server resolves the verified payment's cash posting and passes that exact posting into the existing reconciliation guard; the agent cannot supply an arbitrary posting ID as a dependent stage.

Review the returned `id`, `hash`, ordered cases and evidence. Then call `billy_batch_execute` with `batchId`, `expectedHash` and an audit `authorization` note. A single client approval covers the complete batch. The server prepares and executes one stage at a time through the same guarded engine used by `billy_execute`: original upload if needed, draft bill, optional approval, optional payment, optional reconciliation. It saves each child plan ID and hash before execution, and records completed results. This reduces MCP orchestration calls for a multi-invoice case; it does not make Billy's remote API writes atomic.

`billy_batch_get` shows per-stage plan IDs, partial results and any stop reason. A failed read or definitive rejected child pauses the batch. After inspecting the cause, repeat `billy_batch_execute` with the same batch ID/hash to resume; completed stages return stored evidence and are never sent again. A rejected child can be refreshed only if its current snapshot is unchanged. An unknown or interrupted child write blocks all company writes until its real Billy outcome is investigated through the operator recovery flow. Never create a fresh variant of an uncertain operation to force progress.

If initial evidence changes before a stage starts, execution stops. `billy_batch_refresh` recalculates it and clears approval while no child has completed. After partial execution, inspect completed items and prepare a new batch containing only the remaining cases. The new scope requires approval. A batch runner that exits releases its batch lease for a later process only when it is no longer alive; an executing or unknown child plan still blocks resume. Separate single writes cannot interleave while a batch owns the company lease.

A multi-case execution can outlast a client tool-call timeout. A timeout does not prove the server stopped. Inspect `billy_batch_get` and the child journal; while a runner is active, wait for its status rather than starting another batch or payment. The server cannot roll back completed remote stages.
