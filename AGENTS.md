# Development instructions

- Work on a dedicated branch and worktree; preserve unrelated changes.
- Keep company selection generic: the company-scoped API token selects the tenant.
- Run `npm run check` after executable changes. Automated tests must use fixtures, never production credentials or accounting writes.
- Financial, security and public-contract changes require independent review.
- Keep `.env` files, credentials, receipts, database state and company-specific evidence outside Git. Use synthetic examples in issues and tests.
- Never retry uncertain financial writes or weaken the execution journal to get a test to pass.
- Keep the supported-flow and live-verification documentation accurate.
