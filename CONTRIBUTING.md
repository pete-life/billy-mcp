# Contributing

Open an issue describing the problem or submit a focused pull request. Use synthetic records and redact any accounting information before sharing examples.

Requires Node.js 22.13 or newer:

```sh
npm ci --ignore-scripts
npm run check
```

The tests use temporary directories, simulated Billy responses and real local MCP transport. They do not need an API token. Do not run acceptance tests against another person's company.

Keep changes scoped and explain the behavior and validation in the pull request. Changes to financial writes need regression coverage for wrong amounts/currencies, duplicate attempts and uncertain outcomes as applicable, plus independent review. Do not treat a successful HTTP response as proof of correct accounting.

Public examples must not contain real invoices, company IDs, account identifiers, mailbox addresses, signed URLs or tokens. Keep company profiles and acceptance evidence outside the repository. Documentation-only edits need link/content checks rather than new implementation-mirroring tests.
