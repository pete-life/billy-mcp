# v0.2 implementation and acceptance plan

Status: in progress. Base: v0.1.1. All new accounting flows are tested against synthetic API fixtures; no production accounting mutations or outgoing invoice emails are part of implementation.

## Scope and parallel work

| Track | Deliverables | Acceptance |
| --- | --- | --- |
| A: installation | Scoped npm package, CLI setup/doctor, skill installation, client setup guidance | Pack and install the actual tarball in a fresh directory; start stdio MCP; no credentials in arguments/output; no global config overwritten |
| B: reading/reporting | Compact default responses, explicit full detail, balances, P&L, outstanding bills/invoices, period expenses | Synthetic multi-page and ignored-filter tests; base-currency cents totals; preserve completeness and required identifiers; measure output size |
| C: accounting | Sales invoice create/edit draft, separate send operation, credit notes, partial payments, documented fees | Official API contracts, typed inputs, duplicate and stale-state checks, exact readback, no post-write retries; positive and negative fixtures |
| D: approval/batches | Client-driven approval, concrete multi-item plans, sequential execution, durable item status/resume | Reject declined/unsupported approval, bind authorization to reviewed contents, stop company writes on unknown, retry never duplicates completed items |
| Integration/review | Updated skill/docs, cross-track integration, package/MCP proof, final code review | All expected tracks accounted for, full suite passes, security/privacy checks, no unverified live claims |

A, B and C run independently in separate worktrees. D consumes the integrated operations and read-tool contract. No two writers share a worktree. The coordinator merges explicit commits, resolves conflicts and reviews the final implementation.

## Invariants

- Company-scoped token remains the authority. Public code/fixtures contain no tenant-specific records.
- Existing original-receipt, duplicate, snapshot, bank-match and unknown-outcome checks remain applicable.
- Any financial action, including sending an invoice, has a typed operation and explicit scope. No raw API-write or arbitrary JavaScript escape hatch.
- Caller-provided authorization text is never proof of human approval. Confirmation uses the client's user-facing approval mechanism; locally configured trusted automation remains an explicit operator choice.
- Batches are not remotely atomic. Show item-level outcomes and preserve partial completion durably. An unknown outcome blocks further company writes.
- Compact output changes presentation, not the full internal snapshots or financial verification data. Never silently report truncated financial totals as complete.
- New fee amounts require evidence. Never invent fees from currency differences.
- New capabilities remain fixture-tested until an independently verified, separately authorized live acceptance run.

## Graph contract

Goal: one integrated, reviewed implementation of all listed features.

Fan-out cap: three simultaneous implementation workers in the first wave; one dependent approval/batch worker in the second wave. All user-requested workers run GPT-6 Sol at xhigh.

Node output: committed SHA, changed files, exposed interfaces, exact test results, API evidence and explicit limitations. The coordinator accepts each required track exactly once and records follow-ups rather than dropping failed/missing work. Duplicate features or overlapping symbols are reconciled at integration.

Verification: coordinator review of final code and adversarial cross-track tests; fresh independent read-only review of financial/security/public-contract changes after implementation. Executed test results and a real packed-package MCP startup are the external evidence.

Publication: prepare a reviewable branch/PR. npm upload is separate and requires an authenticated publishing account; none is configured at the start. No production credential migration or financial test transaction is included.

## Completion checklist

- [ ] A installation and fresh-package proof
- [ ] B compact responses and reports
- [ ] C all supported new accounting operations, unsupported cases clearly identified
- [ ] D approval and durable batch execution
- [ ] Integrated tests and documentation
- [ ] Coordinator final review and independent security/financial review
- [ ] Reviewable release candidate with precise remaining dependencies
