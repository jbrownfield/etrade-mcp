---
name: install-etrade-readonly
description: Use when installing or configuring this fork's experimental read-only E*TRADE MCP launcher in a local MCP client, including initial authorization and account selection. Not for trading, portfolio analysis, or the unrestricted server.
metadata:
  status: experimental
---

# Install E*TRADE Read-only — Experimental

Experimental assisted setup; not an unattended installer or a security certification. Tell the user this status when using the skill. Follow their existing authorization and preferences; installing this skill alone does not authorize broker access.

## Find the matching guide

Read `references/installation.md` if bundled with this installed skill. Otherwise read [the package's installation guide](../../docs/readonly-launcher.md), resolved relative to this skill directory. For a skill copied alone without either file, locate the user's trusted checkout or installed package and read its `docs/readonly-launcher.md`; ask for that location if unavailable. Do not improvise missing installation steps or fetch an unrelated version. The guide is the source of commands and provider details.

## Establish the setup

Inspect the chosen package version, OS, Node version, client configuration and existing installation without reading credential values. Resolve user-specific paths locally; never assume a username, Homebrew path, account, or secret-manager ID. Ask only for missing choices: sandbox/production, client, provider, and selected account. Keep working on independent local checks while the user completes provider/browser steps.

Require Node 22+ on macOS/Linux and a source/package containing `etrade-mcp-readonly`. A public npm release or older clone may lack it. Follow the guide's user-local build/archive installation; retain an existing working installation for rollback.

## Configure safely

- Keep credentials in the user's provider. Never ask for secret values in chat or put them in commands, client configuration, logs, repository files, or test fixtures. Have the user save the random 32-byte base64 encryption key directly in the provider. Reuse an existing key; do not silently rotate it.
- Other managers need both helper environment injection and a compatible runtime FIFO. A regular `.env` file is not a fallback. If a provider lacks a compatible adapter, explain the missing capability and stop that dependent step; do not invent an integration.
- Follow interactive authorization from the guide as the same OS user. Let the user sign in and enter the verifier. Do not capture/share the authorization helper's unmasked URL/output.
- Discover accounts only when needed using the temporary read-only setup server. Select exactly one `accountIdKey`, then remove/stop that temporary server. Never enable orders.
- Keep the private three-field configuration outside Git. Validate FIFO type, owner, private permissions, and directory metadata without reading its contents. Use one reader per mount.
- Back up existing client configuration privately and modify only the intended server entry. Use absolute executable/configuration paths. Run the permanent launcher directly, never through `op run` or another eager credential wrapper. Preserve unrelated servers.

## Verify and report

Check help/version and MCP discovery without opening the FIFO: seven read tools, no order mutations, and no credential request during discovery. With user authorization for broker access, make one read-only account call and confirm it returns only the selected account. Without that authorization, report live verification as pending. A failed call is not success; follow renewal/reauthorization guidance without background retries or scheduled credential polling.

Report experimental status, installation/configuration locations, completed checks, any pending user step, and how to restore the previous configuration. Distinguish discovery-only validation from live success. Do not commit, publish, or claim certification as part of setup.
