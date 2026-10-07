# From-scratch installation: read-only E*TRADE MCP

This guide installs `etrade-mcp-readonly` for **one selected account**, with encrypted OAuth tokens and credentials supplied on demand. Startup and tool discovery do not read secrets. It covers a new installation using Codex and 1Password, followed by the contract for other secret managers.

The existing `etrade-mcp` command remains available separately. Do not combine this guide with the README's unrestricted server configuration.

## Optional experimental installation skill

The [install-etrade-readonly skill](../skills/install-etrade-readonly/SKILL.md) lets a compatible coding assistant guide this setup. **Experimental:** it assists with the steps below; it is not an unattended installer or a certification. Manual installation remains supported.

To make it available in Codex, run this from the trusted package/checkout root containing this guide. It copies the skill and the matching guide into your personal skills directory. The command refuses to replace an existing skill; review/update an existing copy deliberately.

```sh
ETRADE_SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/install-etrade-readonly"
if [ -e "$ETRADE_SKILL_DIR" ]; then
  echo 'Skill already exists; review it before replacing.'
else
  mkdir -p "$ETRADE_SKILL_DIR/references"
  cp skills/install-etrade-readonly/SKILL.md "$ETRADE_SKILL_DIR/SKILL.md"
  cp -R skills/install-etrade-readonly/agents "$ETRADE_SKILL_DIR/agents"
  cp docs/readonly-launcher.md "$ETRADE_SKILL_DIR/references/installation.md"
fi
```

Restart Codex if the skill is not discovered, then ask: **“Use $install-etrade-readonly to install this fork's experimental read-only E*TRADE MCP.”** Installing the skill does not install the server or authorize access to your broker account. When updating the skill, copy the guide from the same package revision too.

## 1. Install prerequisites

- **macOS or Linux**, running as your normal user. Windows is unsupported for this launcher.
- [Node.js](https://nodejs.org/en/download) **22 or newer**, including npm. Node runs the installed server.
- [Git](https://git-scm.com/downloads) and [Bun](https://bun.sh/docs/installation) to build from source. Bun is a build dependency; do not use it to run this launcher.
- A local MCP client such as Codex. The examples below use its local configuration, not ChatGPT web.
- For the concrete example: the 1Password desktop app with Environments/local `.env` mounts and [1Password CLI](https://www.1password.dev/cli/get-started), connected to the desktop app. Check `op run --help` for `--environment` support; 1Password currently documents this feature in its beta CLI. See the [current command reference](https://www.1password.dev/cli/reference/commands/run).

Verify your terminal can find the prerequisites:

```sh
node --version
npm --version
git --version
bun --version
op --version
op run --help
```

If your CLI does not support Environments, update it using 1Password's instructions, or use another supported injection method described under alternatives below. Do not put credential values in shell commands.

## 2. Build and install a trusted copy

**Availability:** the portable launcher changes must be present in the source revision you install. Until they are published, a fresh clone of the public repository or the existing npm package may not include them. Obtain the reviewed source checkout or an archive containing these changes from the maintainer. Do not substitute `npm install -g etrade-mcp` and assume it contains this command.

When a source revision containing the launcher is available, replace both placeholders:

```sh
git clone --branch 'BRANCH_OR_TAG_WITH_READONLY_LAUNCHER' 'FORK_REPOSITORY_URL' etrade-mcp
cd etrade-mcp
```

For an existing source checkout, open a terminal in its package directory instead. Confirm it contains `src/mcp-readonly.ts`. Build and pack:

```sh
bun install --frozen-lockfile
bun run build
npm pack --ignore-scripts
```

Use a private, user-owned installation directory. Keep the following terminal open for subsequent steps; these variables are local conveniences, not credentials:

```sh
umask 077
ETRADE_INSTALL_DIR="$HOME/.local/share/etrade-mcp-install"
ETRADE_SETUP_DIR="$HOME/.config/etrade-mcp-setup"
mkdir -p "$ETRADE_INSTALL_DIR" "$ETRADE_SETUP_DIR"
chmod 700 "$ETRADE_INSTALL_DIR" "$ETRADE_SETUP_DIR"
```

Replace the archive placeholder with the absolute path to the `.tgz` printed by `npm pack`:

```sh
npm install --global --prefix "$ETRADE_INSTALL_DIR" --ignore-scripts '/absolute/path/to/etrade-mcp-VERSION.tgz'
ETRADE_PACKAGE_DIR="$ETRADE_INSTALL_DIR/lib/node_modules/etrade-mcp"
ETRADE_NODE="$(command -v node)"
"$ETRADE_NODE" "$ETRADE_PACKAGE_DIR/dist/mcp-readonly.js" --help
"$ETRADE_NODE" "$ETRADE_PACKAGE_DIR/dist/mcp-readonly.js" --version
```

Both checks should exit without requesting credentials. No `sudo`, npm publication, or global shell configuration change is required. Keep this installation directory after setup; the client will execute its files.

## 3. Obtain API credentials and store an encryption key

Request your own developer API credentials through [E*TRADE's getting-started process](https://developer.etrade.com/getting-started). Sandbox and production use different credentials. Production access requires E*TRADE's approval steps; this project supplies no keys or accounts.

In 1Password, create an Environment for this installation. Add the following variables using the app's editor. Choose **one** broker environment:

| Variable | Sandbox | Production |
| --- | --- | --- |
| `ETRADE_ENV` | `sandbox` | `prod` |
| API key | `ETRADE_SANDBOX_API_KEY` | `ETRADE_PROD_API_KEY` |
| API secret | `ETRADE_SANDBOX_API_KEY_SECRET` | `ETRADE_PROD_API_SECRET` |
| `ETRADE_TOKEN_ENCRYPTION_KEY` | Random 32-byte key, canonical base64 | Random 32-byte key, canonical base64 |
| `ETRADE_LOAD_DOTENV` | `0` | `0` |
| `ETRADE_ALLOW_ORDERS` | `0` | `0` |

The API key/secret rows name the variables: enter the corresponding credentials as their values. Notice the different sandbox and production secret variable names.

Generate the encryption key once. On macOS, this copies a new key directly to the clipboard:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" | pbcopy
```

Paste it into `ETRADE_TOKEN_ENCRYPTION_KEY` in 1Password, save, then clear the clipboard. On Linux with a Wayland clipboard, replace `pbcopy` with `wl-copy`; otherwise use a trusted local clipboard utility or your secret manager's generator capable of producing exactly 32 random bytes encoded as base64. Do not use a human password as this value. Keep the same key for authorization, renewal, and the server; replacing it makes existing encrypted tokens unreadable.

Copy the Environment ID from its management menu and set this non-secret reference in the terminal:

```sh
ETRADE_1PASSWORD_ENVIRONMENT='REPLACE_WITH_ENVIRONMENT_ID'
```

## 4. Authorize E*TRADE interactively

Run the packaged authorization helper through 1Password:

```sh
op run --environment "$ETRADE_1PASSWORD_ENVIRONMENT" --no-masking -- "$ETRADE_NODE" "$ETRADE_PACKAGE_DIR/dist/auth.js"
```

This deliberately disables output masking **for the interactive authorization helper only**, because its browser URL contains the API consumer key and must remain usable. Run it in a private terminal; do not record or share its output. Secrets are injected into the child process, not placed in command arguments. See [1Password's run reference](https://www.1password.dev/cli/reference/commands/run).

Approve 1Password access, open the displayed E*TRADE URL yourself, sign in, grant authorization, and enter the verifier at the terminal prompt. Password autofill is not required. Success reports an encrypted token file under `~/.config/etrade-mcp/tokens.prod.json` or `tokens.sandbox.json`.

Use the same OS user throughout setup and when running Codex. Existing plaintext tokens, or tokens encrypted with another key, are not migrated: complete authorization with the intended key.

## 5. Select the account using a temporary server

The restricted launcher requires an account key before it can run. For this setup step only, use the existing server to discover the accounts you authorized. It will be read-only but may list all authorized accounts.

Print the executable paths needed for the configuration; these commands do not read secrets:

```sh
command -v op
printf '%s\n' "$ETRADE_NODE" "$ETRADE_PACKAGE_DIR/dist/mcp.js"
```

Back up your existing `~/.codex/config.toml`, if present. Add this temporary entry, replacing all capitalized placeholders with the actual absolute paths and Environment ID. Preserve other entries:

```toml
[mcp_servers.etrade_setup]
command = "/ABSOLUTE/PATH/TO/op"
args = ["run", "--environment", "ENVIRONMENT_ID", "--", "/ABSOLUTE/PATH/TO/node", "/ABSOLUTE/INSTALL/lib/node_modules/etrade-mcp/dist/mcp.js"]
startup_timeout_sec = 60

[mcp_servers.etrade_setup.env]
ETRADE_LOAD_DOTENV = "0"
ETRADE_ALLOW_ORDERS = "0"
```

The values saved in your 1Password Environment must also have both flags set to `0`, since injected variables take precedence. This temporary entry can request 1Password approval during startup. Restart Codex, then ask: **“Use etrade_setup to list my accounts. Show the accountIdKey for the account I select.”** Keep that response private. Select `accountIdKey`, not the displayed account number.

Remove the entire temporary entry, including its `.env` table, then fully quit Codex to stop it. Do not leave unrestricted account discovery enabled beside the final server. Codex supports these local server tables in its [MCP configuration](https://developers.openai.com/codex/mcp).

## 6. Mount credentials and create the private configuration

In your 1Password Environment, choose **Connect to → Local .env file**, select a path inside the private setup directory, and mount it. Use the absolute path printed here as the destination; do not create a regular file at that location first:

```sh
printf '%s\n' "$ETRADE_SETUP_DIR/credentials.env"
```

See [1Password's local mount instructions](https://www.1password.dev/environments/local-env-file). Verify only its metadata:

```sh
ls -ld "$ETRADE_SETUP_DIR"
ls -l "$ETRADE_SETUP_DIR/credentials.env"
test -p "$ETRADE_SETUP_DIR/credentials.env" && echo 'Named pipe present'
```

The mount must be a named pipe owned by your user with permissions `prw-------` (mode `600`); the directory should be `drwx------` (mode `700`). If the provider creates different permissions, correct its configuration before continuing. Do not inspect the mount with `cat`, preview it in an editor, or place it where an IDE/file watcher might read it.

Copy the supplied example:

```sh
cp "$ETRADE_PACKAGE_DIR/examples/readonly-config.example.json" "$ETRADE_SETUP_DIR/readonly.private.json"
chmod 600 "$ETRADE_SETUP_DIR/readonly.private.json"
```

Edit that private copy to contain these three fields, replacing the selected account key and using `prod` instead of `sandbox` if appropriate:

```json
{
  "environment": "sandbox",
  "credentialMount": "credentials.env",
  "accountIdKey": "REPLACE_WITH_YOUR_ACCOUNT_KEY"
}
```

The mount path is relative to this configuration file. Absolute paths also work; `~` and shell variables are not expanded. Do not add API credentials, encryption keys, or extra fields. Keep the file outside Git even though it contains no credential values.

## 7. Connect the restricted server to Codex

Print the paths to substitute below:

```sh
printf '%s\n' "$ETRADE_NODE" "$ETRADE_PACKAGE_DIR/dist/mcp-readonly.js" "$ETRADE_SETUP_DIR/readonly.private.json"
```

Add this entry to `~/.codex/config.toml` with the actual absolute paths. If that server name already exists, update its table rather than adding a duplicate:

```toml
[mcp_servers.etrade_tracker]
command = "/ABSOLUTE/PATH/TO/node"
args = ["/ABSOLUTE/INSTALL/lib/node_modules/etrade-mcp/dist/mcp-readonly.js", "--config", "/ABSOLUTE/SETUP/readonly.private.json"]
tool_timeout_sec = 90
```

Start Codex again. **Do not wrap this permanent command in `op run`**: the launcher itself reads the mount only when a valid tool request needs credentials. No credentials belong in the MCP configuration. Other local MCP clients can use the same `command` and argument list in their own configuration format.

## 8. Verify the installation

1. Tool discovery should complete without a 1Password request. The seven tools are `etrade_list_accounts`, `etrade_get_balance`, `etrade_get_portfolio`, `etrade_list_transactions`, `etrade_get_transaction`, `etrade_list_orders`, and `etrade_snapshot`. Preview, place, and cancel tools must be absent.
2. Ask: **“Use etrade_tracker to list my configured account.”** This explicit call may request 1Password access. Approve promptly; the credential read allows 45 seconds.
3. Confirm exactly the selected account appears. Then request its balance or holdings to test a normal read.
4. Leave the connection idle. The launcher does not poll the credential provider or renew broker tokens in the background.

Successful discovery proves configuration/startup only; a successful account request verifies the credentials, encrypted token, broker authorization, and account restriction together. Locking 1Password does not erase credentials already loaded into a running backend. Quit/stop the server to end that process. Provider approval rules are separate from MCP tool approvals; do not assume every read requires a fresh biometric prompt.

## 9. Renew or reauthorize later

An idle session may need renewal. In the setup terminal (restore the variables from earlier steps if you opened a new terminal), run:

```sh
op run --environment "$ETRADE_1PASSWORD_ENVIRONMENT" -- "$ETRADE_NODE" "$ETRADE_PACKAGE_DIR/dist/auth-renew-cli.js"
```

If renewal fails, repeat step 4. Tokens expire at midnight Eastern; renewal does not extend them past that boundary. Use the same environment and encryption key each time. Reconnect the MCP server if it still reports a rejected session. The launcher does not perform automatic browser authorization or scheduled renewal.

## Alternatives to the 1Password example

The launcher is provider-neutral, but it needs **two capabilities**: private environment injection for the authorization/setup helpers, and a compatible FIFO for normal operation. Replace the `op run ... --` prefix with your manager's injection command, preserving the variables in step 3. For 1Password installations using vault secret references instead of CLI Environments, `op run --env-file /absolute/private/references.env -- ...` is an alternative for helpers; that file should contain only `op://` references, not credential values. It does not by itself create the mounted Environment required by the launcher.

Other managers require a provider/adapter meeting the contract below. This repository does not supply those adapters. A regular plaintext `.env` file or inherited environment variables cannot substitute for the runtime FIFO.

## Configure a credential provider

The launcher consumes a **named pipe (FIFO)**, not a regular `.env` file. 1Password's environment mount is one example; other secret managers need a compatible provider or adapter. The project does not include turnkey integrations for other managers.

The provider writes UTF-8 dotenv content containing these keys:

| Environment | Required API variables |
| --- | --- |
| Sandbox | `ETRADE_SANDBOX_API_KEY`, `ETRADE_SANDBOX_API_KEY_SECRET` |
| Production | `ETRADE_PROD_API_KEY`, `ETRADE_PROD_API_SECRET` |

Both require `ETRADE_TOKEN_ENCRYPTION_KEY`, containing the same base64 key used during authorization. Other payload variables are ignored and cannot enable trading, change accounts, or change the token location.

The provider must open the pipe for writing, write one complete payload, and **close its writer** so the reader sees EOF. The launcher requires the FIFO to be owned by the current user with no group/other permissions (normally mode `600`). Keep its containing directory private as well (mode `700`). For a manually managed pipe, create it with `mkfifo -m 600 credentials.pipe` inside that private directory. If a secret manager manages the mount, configure these permissions through that provider. Use one active launcher/reader per pipe; configure separate mounts for simultaneous MCP clients. Do not use a provider that holds the writer open indefinitely. After failed initialization or backend exit, a later explicit tool request can reopen the pipe, so the provider must support repeated reads. The launcher does not periodically fetch credentials or retry by itself.

Credential approval/read has a 45-second deadline and 64-KiB limit. Entire backend initialization has a 55-second deadline. A timeout or cancellation closes the reader; providers must handle closed readers and may need to repopulate the pipe on the next request. Regular files and symlinks are refused. Parent environment credentials are not a fallback.

## Troubleshooting

| Symptom | Check or action |
| --- | --- |
| Installed command or `dist/mcp-readonly.js` is missing | The checkout/package must contain the portable launcher changes. Build before packing and install the resulting archive. |
| Codex cannot start the process | Use existing absolute Node/package/config paths. Verify Node is 22+. Restart after editing configuration. |
| Secret approval appears during tool discovery | Remove the temporary setup server and any `op run` wrapper around the permanent launcher. Check for other clients or file watchers reading the same mount. |
| Credential initialization times out | Approve within 45 seconds, verify the mount is active, then retry an explicit tool call. The provider must close its writer after each payload. |
| Mount is rejected | It must be a real FIFO, not a regular file or symlink, owned by your user with no group/other permissions. |
| Authentication fails | Check matching sandbox/production credentials, the original encryption key, token authorization, and the selected account key. Try renewal, then browser reauthorization if required. |
| Unexpected or multiple accounts appear | Confirm the temporary setup server is removed and the client is calling `etrade_tracker` from this guide. |
| Prompts appear after locking 1Password | Identify the reader. This launcher does not poll, but another process or an explicit tool call may open the mount. |


- Initialization, ping, and tool discovery should not request credential approval. Seven read tools should appear, with no preview, place, or cancel tools.
- Your first valid account request may prompt through the credential provider. Approve it to start the restricted backend.
- Subsequent calls reuse the backend while it remains connected. Locking the secret manager does not erase credentials already held by a running process. Stop the MCP server to end that process.
- If access is unavailable, check provider approval, required payload variables, selected environment/account, and broker authorization. Reauthorize using the same encryption key when necessary. Errors intentionally omit secret-bearing details; backend stderr is discarded.
- Tool calls use the SDK's default request timeout; an MCP client may impose a shorter one. Long snapshots can therefore time out.
- After a server upgrade, reconnect your MCP client. Catalog/schema mismatches fail closed rather than advertise tools the backend does not support.

Token encryption protects files at rest, not against software that can inspect the running user's process memory. These controls do not replace trust in the installed package, local user account, MCP client, or credential provider.

## Update or uninstall

Before updating an existing installation, stop its MCP process and save a private backup of the installation directory and the client configuration. Prefer installing the new archive into a separate user-owned directory, then change only the server executable path in the client configuration. To roll back, stop the new process, restore the previous server entry and retained installation, and restart the client. Build and pack the new trusted revision as in step 2. Retain your private configuration, mounted Environment, encryption key, and token files. Package and backend must come from the same build; a catalogue mismatch is rejected.

To disconnect, remove the `etrade_tracker` table from the MCP configuration and fully quit/restart the client. Unmount the Environment if no other client needs it. This stops local access; removing the MCP entry does not revoke the E*TRADE authorization. Use E*TRADE's own authorization controls when revocation is desired. Uninstall the package only after stopping its processes:

```sh
npm uninstall --global --prefix "$ETRADE_INSTALL_DIR" etrade-mcp
```

This does not delete your secret-manager entries, private setup configuration, or encrypted tokens.

## Development and tests

```sh
bun run build
bun run test
bun run typecheck
bun run test:node
```

Source unit tests run without a prior build. Node process/catalog tests require `dist` and fail with build-first guidance if it is absent. Tests use dummy credentials and temporary FIFOs/homes; they do not call E*TRADE or access a real secret manager. macOS and Linux CI cover the FIFO path. The catalog is bundled from `src/readonly-tool-catalog.json`; update it intentionally when the backend's read tools change, and verify it against the built backend.

Local files matching `*.private.json` and `.local-state/` are ignored as an extra safeguard. Ignore rules do not remove files already tracked in Git or erase history. Inspect both your diff and package contents before sharing a build.
