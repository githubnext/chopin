# Test PR previews with Playwright

Chopin publishes a Coolify deployment for each trusted pull request. A coding
agent can inspect that deployment through Playwright MCP, including the real
GitHub App OAuth flow, without putting a GitHub password in the repository or
the model context.

This setup is independent of the agent harness. The harness needs to run one
local stdio MCP server, pass it one environment variable, retain a browser
profile, isolate provenance from browser execution, restrict tools, and load
the preview-testing instructions. The exact configuration file differs between
clients.

## How authentication works

There are two browser sessions:

- GitHub's session belongs to the dedicated test account and lives in
  Playwright's persistent browser profile. It can survive agent and browser
  restarts.
- Chopin's session is an HttpOnly cookie scoped to one preview hostname and one
  running server process. Every PR preview needs its own OAuth round trip, and a
  redeploy invalidates the old Chopin session.

The first OAuth round trip usually asks GitHub for a password and may require
device, email, 2FA, or passkey verification. Later previews normally reuse the
GitHub session and redirect straight back to Chopin. In Playwright MCP 0.0.78,
the secret loader replaces a secret name supplied through `browser_type` or a
textbox/slider value in `browser_fill_form`, then redacts that value from text
responses. Other tools do not perform this substitution. Redaction is a
convenience, not a security boundary.

## Security boundary

Preview code receives a GitHub App user token after OAuth. Authenticate only to
reviewed, trusted, same-repository PRs. Never authenticate to a fork or to code
whose exact head commit has not been reviewed.

Use a dedicated low-value GitHub account with all of these properties:

- A unique password and no access to valuable repositories or organizations.
- Write access to exactly one disposable sandbox repository.
- No unrelated tokens, SSH keys, Apps, billing access, or organization roles.
- Access to a GitHub App installation that exposes only that sandbox.

The sandbox restriction is the real boundary. Selecting one repository in the
Chopin UI does not reduce permissions already granted to the GitHub account or
App token.

Do not store a TOTP seed, passkey, recovery code, email credential, or GitHub
session cookie in the Playwright dotenv file. Complete additional verification
interactively when GitHub requests it.

### Separate provenance from browsing

Use two permission phases or two agents:

1. A provenance coordinator has `git`, authenticated `gh`, `jq`, and repository
   read access, but no preview credentials and no authenticated browser. It
   validates the PR, head commit, trusted Coolify comment, hostname, and
   deployment ordering.
2. A browser worker receives only the validated preview URL, expected commit and
   identity markers, and the requested test scope. It has the restricted
   Playwright tools and secret file, but no shell, filesystem, GitHub CLI,
   generic HTTP-fetch, or coding tools.

Never let an agent consuming untrusted preview content retain shell or workspace
read access. Page text can contain prompt injection. If a harness cannot isolate
these phases, do not give its browser process the login secret file.

## Deployment prerequisites

The preview GitHub App must accept the preview callback and include the sandbox
repository. Register every exact preview callback URL, or use a dedicated
preview-only App with wildcard callback matching enabled for the narrowest
possible preview domain. A wildcard trusts every matching sibling host, so do
not reuse a production App or a broad organizational domain. See
[Authentication](authentication.md) and [Remote development](exe-dev.md) for App
permissions, callback matching, and setup-URL limitations.

In Coolify's **Preview deployments** environment set:

```dotenv
APP_ORIGIN=https://${SERVICE_FQDN_APP}
GITHUB_APP_SLUG=<preview-app-slug>
GITHUB_APP_CLIENT_ID=<preview-app-client-id>
GITHUB_APP_CLIENT_SECRET=<preview-app-client-secret>
GITHUB_ALLOWED_USERS=<test-account-login>
SESSION_ENCRYPTION_KEY=<preview-only-64-hex-character-key>
```

`GITHUB_ALLOWED_USERS` must be a runtime variable. Organization admission is a
union with explicit users, so an existing `GITHUB_ALLOWED_ORGANIZATIONS` value
may remain configured. When previews use a dedicated App, all three App values
above must be preview runtime overrides rather than production credentials.
Generate a separate preview OAuth-state key with `openssl rand -hex 32`; do not
expose the production `SESSION_ENCRYPTION_KEY` to PR code.

Coolify builds the image from the PR but generates the deployment Compose from
the configured production branch. Preview-overridable entries in
`compose.yaml` must therefore remain direct `${NAME}` references on that branch;
`${NAME:-default}` is resolved from production early enough to override the
preview env file. A PR cannot validate its own Compose fix. Merge a reviewed
Compose prerequisite first, then redeploy the feature PR.

The server's startup summary should report at least one configured user:

```text
auth: github (restricted: 1 users, ... organizations)
```

## Install operator tools

The provenance phase requires Git, an authenticated GitHub CLI, `jq`, and Bash
or zsh for `pipefail`:

```bash
git --version
gh auth status
jq --version
```

The GitHub CLI account needs read access to `githubnext/chopin` so it can inspect
PR metadata and trusted bot comments. Do not pass its token or configuration to
the browser worker.

## Configure Playwright MCP

The repository currently pins `@playwright/mcp@0.0.78`. Use the same version in
every harness so tool behavior and secret substitution stay reproducible.

### Install Chrome

Install the browser once on the machine that runs the MCP server:

```bash
bunx @playwright/mcp@0.0.78 install-browser chrome
```

The installer may request elevated privileges on Linux. A missing installation
appears as `Chromium distribution 'chrome' is not found` when the first browser
tool runs.

### Provide a visible first-login path

Playwright MCP 0.0.78 runs headless on Linux when `DISPLAY` is unavailable.
Password filling works headlessly, but device approval, 2FA, passkeys, and
security keys may require a browser the operator can see and control.

Bootstrap a persistent profile from a headed desktop/remote-display MCP session,
using the same workspace or explicit `--user-data-dir` that later automated runs
will use. Complete GitHub verification there, close the headed process, and then
reuse that dedicated profile.

Alternatively, use Playwright MCP's Chrome/Edge extension mode and continue to
use extension mode for later runs. Extension login state is not copied into the
default MCP profile. Attach only to a dedicated clean browser profile, never the
operator's normal browser with valuable tabs, cookies, or accounts.

Do not send TOTP, passkey, recovery, or security-key material through the agent
conversation. If no visible or extension-backed browser is available, stop at
the challenge rather than weakening the account.

### Create the external secret file

Choose a path outside every repository, for example:

```text
~/.config/chopin/preview-playwright.env
```

Create it with these keys:

```dotenv
CHOPIN_PREVIEW_GITHUB_USERNAME="test-account-login"
CHOPIN_PREVIEW_GITHUB_PASSWORD="unique-test-account-password"
CHOPIN_PREVIEW_GITHUB_APP_NAME="expected-preview-app-name"
CHOPIN_PREVIEW_REPOSITORY="owner/sandbox-repository"
```

Restrict the file to its owner:

```bash
chmod 600 ~/.config/chopin/preview-playwright.env
```

Never commit this file, place it under the workspace, print it through an agent
tool, or paste its values into a prompt. The repository name is configured in
the same file so the workflow can refuse every other repository.

### Register the local server

Translate this harness-neutral contract into the client's local MCP format:

```text
transport:   stdio
command:     bunx
arguments:   @playwright/mcp@0.0.78 --browser chrome
environment: PLAYWRIGHT_MCP_SECRETS_FILE=/absolute/path/to/preview-playwright.env
```

Do not pass `--isolated`. Without it, Playwright uses a persistent,
workspace-scoped profile and keeps the GitHub session. A profile can be opened
by only one browser process at a time; concurrent harnesses need distinct
`--user-data-dir` values outside the repository.

Clients using the common `mcpServers` JSON shape can express the contract like
this:

```json
{
	"mcpServers": {
		"playwright": {
			"command": "bunx",
			"args": ["@playwright/mcp@0.0.78", "--browser", "chrome"],
			"env": {
				"PLAYWRIGHT_MCP_SECRETS_FILE": "/absolute/path/to/preview-playwright.env"
			}
		}
	}
}
```

Claude Code, Codex CLI, Cursor, GitHub Copilot CLI, and OpenCode use different
names around the same command, arguments, and child-process environment. Prefer
user-level secret paths or parent environment references over committing a
harness-specific credential path.

### Restrict browser tools

Disable these Playwright tools for any agent that receives the secret file:

```text
browser_drop
browser_evaluate
browser_file_upload
browser_network_request
browser_run_code_unsafe
```

Harnesses may prefix MCP tool names with the server name, such as
`playwright_browser_evaluate`. Unsafe code can read the MCP process environment
or persistent cookies. Evaluation and raw request inspection can encode values
in ways exact-string redaction does not catch. Upload and drop tools can send a
workspace `.env` file to an untrusted page.

If a harness cannot deny individual tools, use a dedicated agent/profile that
exposes only navigation, find, click, type/fill, selection, tabs, waiting,
hover, key presses, and resizing. Do not provide login secrets to an
unrestricted browser tool set.

Do not expose `browser_snapshot`, `browser_console_messages`, or
`browser_network_requests` unless the harness can reject their optional
`filename` argument. In Playwright MCP 0.0.78 that argument can write inside the
workspace even when ordinary filesystem tools are denied. `browser_find` and
the automatic summaries returned by navigation and actions are sufficient for
the preview workflow without granting a browser file-write path.

The browser worker must also deny shell, terminal, file read/write/search,
GitHub CLI, generic network fetch, code execution, subagent delegation, and
repository editing tools. The provenance coordinator must not open the preview
or receive the Playwright secret file. Pass validated metadata between them as
plain task input.

### Load the operating instructions

The repository provides
`.agents/skills/testing-pr-previews/SKILL.md` in the portable Agent Skills
format. Skill discovery paths vary by harness; verify that the client actually
lists `testing-pr-previews` before relying on it. For a client without Agent
Skills support, add that file to the agent's project instructions or require the
provenance and browser workers to read it before their respective phases.

Claude Code discovers user skills under `~/.claude/skills`, not directly under
the repository's `.agents/skills`. Install a user-level symlink to the canonical
skill:

```bash
mkdir -p "$HOME/.claude/skills"
ln -s "$PWD/.agents/skills/testing-pr-previews" \
  "$HOME/.claude/skills/testing-pr-previews"
```

Do not commit a harness-specific copy that can drift from the canonical skill.

The skill is part of the security procedure. It validates PR provenance and the
Coolify bot URL, serializes pushes and deployments, verifies the GitHub account
before OAuth, checks secret substitution before submitting a password, and
refuses additional repositories.

## Harness notes

The checked-in `opencode.json` is one implementation of the generic contract.
Normal OpenCode agents are denied every Playwright tool. Run provenance in one
ordinary session without the secret-file variable, then close it. The
`preview-browser` primary agent allowlists only safe Playwright operations and
the canonical skill. `opencode.preview.json` is a launch-only overlay that
disables every other primary agent, denies default tools, and disables the
GH-token Chopin MCP. Launch the isolated process with:

```bash
CHOPIN_PREVIEW_SECRETS_FILE="$HOME/.config/chopin/preview-playwright.env" \
  OPENCODE_CONFIG_CONTENT="$(<opencode.preview.json)" \
  opencode --agent preview-browser
```

Other harnesses should set `PLAYWRIGHT_MCP_SECRETS_FILE` directly in their
local-server environment unless they need a similar indirection, and create an
equivalent separate browser-only process or session. Do not automatically return
free-form browser content to a privileged provenance agent; return a fixed,
concise status to the operator. Restart the harness after changing MCP
configuration, environment variables, permissions, or skills; these are
normally read only at startup.

## Run the first smoke test

1. Confirm the test account and App installation still expose only the sandbox.
2. Confirm the PR head is reviewed and trusted.
3. Run the provenance phase and retain its validated URL, exact head commit,
   trusted-comment timestamp, and allowed test scope.
4. Start the browser worker with the MCP environment configured and all
   non-browser tools denied.
5. Give it only the validated metadata and state whether persistent changes,
   such as creating a channel, are allowed.
6. Complete any GitHub device or second-factor verification when requested.
7. Verify that the browser worker reports the redacted username, one writable
   sandbox, the checks performed, and any page or interaction failure.

When the agent fills the GitHub form, generated Playwright code must refer to
the secret names, for example:

```js
await page.getByLabel("Password").fill(process.env["CHOPIN_PREVIEW_GITHUB_PASSWORD"]);
```

If it instead shows the literal key name, the secret file was not loaded. Do
not submit the form; fix the child-process environment and restart the harness.

## Troubleshooting

**GitHub asks for device verification.** Complete the short-lived challenge and
continue. The persistent profile should prevent repeated password prompts.

**The callback reports organization membership is temporarily unavailable.**
The explicit user did not match the running preview policy, so Chopin fell
through to organization admission. Check the latest startup summary. `0 users`
means the preview value did not reach the process; verify the Coolify Preview
runtime value and the direct Compose reference on the production branch.

**The preview returns to sign-in after a redeploy.** This is expected. Chopin
sessions are process-local; start OAuth again. The GitHub profile remains
signed in.

**More than one repository is visible.** Stop. Reduce the test account and App
installation to the single sandbox before continuing.

**The browser profile is locked.** Close the other MCP browser process or give
each concurrent harness a distinct external `--user-data-dir`.

**The Coolify ready comment predates the current push.** Do not authenticate.
Wait for its trusted bot comment timestamp to advance. If pushes overlapped or
the previous timestamp was not recorded, require an operator to attest the
exact deployed commit.

## References

- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Authentication](authentication.md)
- [Remote development](exe-dev.md)
- [Claude Code MCP servers](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Codex CLI MCP servers](https://developers.openai.com/codex/mcp/)
- [GitHub Copilot CLI MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
