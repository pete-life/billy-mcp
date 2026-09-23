# Security

Use GitHub's private vulnerability reporting for this repository when enabled. Do not include credentials, receipts, personal data or production accounting records in a public issue. If private reporting is unavailable, open a minimal issue requesting a private contact route without disclosing the vulnerability.

This server is designed for a trusted local MCP client over stdio. It does not provide a remote HTTP authentication layer. The company API token can access real financial data. The default confirm mode requires form approval from that trusted client for an exact operation or batch. The agent-provided authorization note is not proof of consent. Locally choosing trusted_automation disables the form requirement; the write switch, guarded plans and unknown-outcome stops still apply.

Keep the data directory local and private. It includes receipt originals, extracted data, record snapshots and the operation journal. Never commit or sync it into a public repository. Use separate profile directories for independent deployments; SQLite locking does not coordinate multiple machines or simultaneous manual changes in Billy.

Writes are disabled by default. A write with an uncertain result blocks further company writes until an operator investigates the live records and performs documented recovery. Do not bypass that guard or assume that retrying is safe.

At this early stage, fixes target the latest source revision. No long-term support policy is established.
