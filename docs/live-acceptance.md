# Verification scope

Automated checks cover receipt integrity/provenance, company isolation, pagination, bounded read retries, non-retried writes, stale proposals, persistent execution claims, uncertain outcomes, financial preconditions, operator recovery and actual MCP stdio transport. Run `npm run check` for the current suite.

The following flows were exercised through the live Billy API and independently read back during development:

- Original PDF upload, supplier identity checks, Danish purchase VAT, draft creation, approval and balanced ledger.
- USD software purchase with the non-EU services reverse-charge tax code and matching input/foreign-services VAT entries.
- Same-currency DKK supplier payment and single-bank-line reconciliation to its existing payment posting.
- Full USD supplier-bill payment from a DKK base-currency bank account, including automatic realized currency difference, zero outstanding balance and one-line reconciliation.

No private invoices, company profile, record identifiers or acceptance payloads are distributed. These checks establish the tested patterns, not correctness for every company or accounting situation.

Vendor-portal downloads rely on the calling agent's tools and have not been covered by a universal integration test. Other tax patterns, tax-coded journals, grouped/partial foreign settlements, explicit payment fees, refunds and foreign sales-invoice payments are outside the verified scope.

For a new deployment, first verify company identity and read-only records. Enable writes only for a concrete authorized case. After execution, verify the original attachment, amounts, currency, tax treatment and ledger. Distinguish approved, paid and bank-reconciled states. Never use live transactions merely to test documentation changes.

## Version 0.2 evidence

On 2026-09-23, all four new reports (trial balance, profit/loss, period expenses and current outstanding documents) completed against a connected Billy company through a GET-only transport. The full trial balance balanced. No private values or record IDs are included here. Synthetic tests separately cover ignored filters, pagination, credit-note separation and missing FX base amounts.

The newly added sales draft/send, customer/supplier credit-note, partial FX and explicit-fee paths remain fixture tested. MCP form acceptance/decline and the dependency-aware batch flow have synthetic integration tests. Those tests are not live financial acceptance. The packaged tarball is also installed in a fresh temporary directory and initialized through real MCP stdio without credentials.
