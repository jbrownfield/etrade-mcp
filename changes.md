# Changes

## Unreleased

- Include an experimental installation skill with Codex metadata, matching-guide installation instructions, and explicit separation of startup checks from live broker verification.

- Expand the installation guide with clean-source installation, credential setup, interactive authorization, account selection, Codex configuration, verification, and renewal instructions using portable placeholders.

- Add an optional `etrade-mcp-readonly` command with portable private configuration and on-demand FIFO credentials. Startup and tool discovery do not open the credential provider.
- Require encrypted tokens, one selected account, explicit sandbox/production selection, and read-only policy in this entrypoint. The existing server's configuration remains unchanged.
- Bound and cancel credential reads and backend initialization; sanitize errors, validate requests/catalog schemas, and recover from backend exit on a later tool request.
- Clean up backend processes on disconnect, including overlapping cancellation/close and stubborn-child cases.
- Include provider-neutral setup documentation, a dummy configuration example, and offline protocol, policy, FIFO, package and lifecycle checks.
- Require Node 22+ on macOS/Linux for the new command. Raise the MCP SDK minimum to the tested 1.32.1 release for the public schema-validation API and reviewed cancellation/transport behavior.

## Earlier fork changes

- Harden read-only request routing, account restrictions and broker error handling.
- Add optional encrypted token storage and stricter renewal validation.
- Improve snapshot pagination, duplicate detection, explicit completeness and Eastern date handling.
- Disable password-autofill execution and direct users to manual browser authorization.
- Add regression tests and document the original project's attribution separately in the fork README.

### Combined review follow-up

- Require credential FIFOs to be owned by the current user with no group/other permissions; document separate pipes for simultaneous readers.
- Reject unknown tool arguments before credential acquisition, including when the backend's schema allows extra properties.
- Require canonical base64 encryption-key encoding and clear initialization timers/listeners after completion.
- Extend offline checks for delayed multi-chunk pipe writers, private pipe permissions, discovery without pipe readers, and actual idle-backend exit after forced launcher termination.
