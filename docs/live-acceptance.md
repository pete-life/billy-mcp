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
