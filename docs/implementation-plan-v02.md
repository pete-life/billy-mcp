# v0.2 implementation and acceptance plan

Status: implemented and reviewed as a v0.2 release candidate. Base: v0.1.1. All new accounting flows are tested against synthetic API fixtures; no production accounting mutations or outgoing invoice emails are part of implementation.

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

- [x] A installation and fresh-package proof
- [x] B compact responses and reports
- [x] C all supported new accounting operations, unsupported cases clearly identified
- [x] D approval and durable batch execution
- [x] Integrated tests and documentation
- [x] Coordinator final review and independent security/financial review
- [x] Reviewable release candidate with precise remaining dependencies

## Final coordinator review and evidence (2026-09-23)

All four tracks were integrated. Implementation and independent reviewers used GPT-6 Sol at xhigh; the coordinator reviewed the combined source and resolved cross-track contracts.

Review fixes include an immediate pre-payment subject snapshot check, original/sibling credit limits at approval, nonnegative credit evidence, exact created/approved bill lines, immutable sales-draft lines, and dependent batch approval bound to the created bill. The refreshed rejected-child path and partial-result output were corrected. Integration testing also caught inclusive-tax line amounts: batch comparison now matches Billy's net-plus-tax response to the reviewed gross input.

- `npm run check`: **90/90 passing tests**, including real SDK form acceptance/decline, complete batch stages, process locking and unknown/recovery cases.
- The actual npm tarball was installed in a fresh temporary directory, its packaged skill/documents verified, and the installed executable initialized over MCP stdio without credentials.
- All four report paths completed using a GET-only live Billy transport; the full trial balance balanced. This read-only probe does not establish new financial-write acceptance.
- Skill frontmatter validation and `git diff --check` passed. The public source and fixtures contain no private company markers or receipt evidence.
- Both independent focused review rechecks cleared their original blocking findings. A further signed-credit cap case was closed with a nonnegative guard and a regression test; the final complete suite includes it.

Remaining release dependencies: the scoped npm package is not published and this host has no npm publishing login. New sales, credit-note, partial-FX and fee writes still need separately authorized live acceptance. No production credential migration, live accounting write or email send was part of this implementation. Invoice line replacement, credit-note refund/application, grouped bank matches and remote API atomicity remain explicit unsupported cases.
