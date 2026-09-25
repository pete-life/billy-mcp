# Install Billy MCP locally

Billy MCP requires Node.js 22.13 or newer. It runs as a local MCP stdio process. The npm package name is `@pete-life/billy-mcp`; the unscoped `billy-mcp` name belongs to another project. Version 0.2.1 is available as a GitHub release tarball. The same package is published on npm; use the registry command below, the release tarball, or the repository build instructions in [README](../README.md).

```sh
npm install -g @pete-life/billy-mcp@0.2.1
billy-mcp --help
billy-mcp setup
billy-mcp doctor
```

Run `setup` yourself in an interactive terminal. It hides token entry, reads the company identity from Billy, asks you to confirm it, and saves a local `credentials.env` with owner-only permissions under `~/.local/share/billy-mcp/`. Create a company API token in Billy under Settings → Access tokens. Never provide the token in chat, a command argument, a skill file or an MCP client configuration. Setup refuses to replace an existing credentials file. `doctor` performs a read-only connection check and reports the selected company and the current write switches.

For a separate company profile, set `BILLY_DATA_DIR` to a distinct directory when you run `setup`, `doctor`, and the MCP client process. The token selects the company. Setup also saves its company ID as a guard against a mismatched token. Keep the data directory private; it contains credentials, receipt originals, plans, execution evidence, and optional vendor notes. Do not put it in a source checkout or share it across machines.

## Connect an MCP client

Configure a client that supports **local stdio MCP servers** with the example below. `billy-mcp client-config` prints the same generic JSON. Adapt the wrapper keys to your client's MCP settings format. The process must inherit the same profile environment used at setup. No token is embedded in the configuration.

```json
{
  "mcpServers": {
    "billy": {
      "command": "billy-mcp",
      "args": []
    }
  }
}
```

The example assumes the package was installed globally. If your desktop client cannot find `billy-mcp` or Node 22.13+, use absolute executable paths supplied by your local Node installation. The generated `client-config` alternatively uses a version-pinned npm registry command. Starting `billy-mcp` with no subcommand uses stdout only for MCP protocol messages. Setup, diagnostics, and skill installation are separate terminal commands.

The server's `bookkeeping-period` prompt includes the bundled skill, so a separate skill installation is optional. For a skill-aware client, install a copy explicitly:

```sh
billy-mcp skill install --client codex
# or: billy-mcp skill install --client claude
# or: billy-mcp skill install --path /absolute/path/to/your/skills
```

The command copies to a `billy-bookkeeping` subdirectory and refuses to overwrite an existing skill. It does not change MCP settings. The skill uses the calling agent's own mail, file, and browser connections for receipts and vendor portals; those connections are not bundled with this server.

Local stdio support does not make the server a hosted ChatGPT Work connector or plugin. A client must be able to start a local process and access its local files. Your model provider may receive the accounting data your agent sends it; “local server” describes where the MCP process and files run, not where the model runs.

Writes and bank matching are off by default. Enabling them in the local profile only makes those capabilities available; each accounting action still needs its own reviewed scope. An uncertain write requires inspecting Billy and using the interactive `billy-mcp recover PLAN_ID applied|not_applied` command with concrete evidence. See [supported operations and limits](../README.md#supported-operations) before use.

## Give this to your agent

> Install the local Billy MCP from https://github.com/pete-life/billy-mcp and its bundled billy-bookkeeping skill. Check the release and Node requirements first. Until the scoped npm release exists, build the repository. Configure my client's local stdio connection without overwriting unrelated settings. Guide me through entering my own Billy API token in the hidden local setup prompt, then verify the company using read-only calls. Keep financial writes disabled until I enable them. Explain whether my client supports the default approval form. Receipt collection should use my existing mail/file tools and vendor billing accounts. Do not put my credentials or company records in chat or the repository.

For execution approval and durable multi-invoice work, read [client approval and purchase batches](batches.md). A client without MCP form elicitation cannot use default financial execution; an operator may explicitly configure `BILLY_APPROVAL_MODE=trusted_automation` for previously authorized automation. An agent should not change that choice merely to bypass a declined or unsupported approval request.
