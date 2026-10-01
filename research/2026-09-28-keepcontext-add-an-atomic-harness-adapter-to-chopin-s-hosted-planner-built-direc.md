# Research report: adding an `atomic` Planner harness to Chopin on the Atomic SDK

The research is done and the design is feasible. I ran a scratch spike against the installed Atomic 0.9.23 and the repo's own model stub, in `/tmp/atomic-spike/` outside the repository. It confirmed the in-process design: `createAgentSession()` with a custom `DefaultResourceLoader`, in-memory session and settings managers, and a `ModelRuntime` using `AuthStorage.inMemory()`. I changed no repository files.

The SDK does **not** give most of the guarantees by default. The adapter has to set them explicitly and check them itself. Five problems need handling, and each has an SDK option or hook that solves it:

1. **Unknown models fall back silently.** Passing `model: undefined` makes Atomic pick the first available model with no `modelFallbackMessage`. The adapter must look the model up itself and fail the turn.
2. **An empty system prompt brings in Atomic's coding-assistant prompt.** That text includes an Atomic docs section. The adapter must always force the exact per-turn system prompt.
3. **`prompt()` does not reject on abort or model error.** It resolves normally; the failure only shows on the last assistant message and `agent.state.errorMessage`.
4. **A host tool that ignores its abort signal makes `abort()` and `prompt()` hang.** The adapter must settle pending host-tool promises when the turn aborts.
5. **Large tool results are written to disk.** Results over 50,000 characters are saved to a temp file and the model gets only a preview and a path. Host tools should set `maxResultSizeChars: Infinity`.

No `bun patch` looks necessary. Every safety need maps to a supported option or extension hook.

## Contract amendments received

None. No steering or follow-up messages arrived during this stage. The launch objective and acceptance criteria are the whole contract.

## Compatibility posture

`breaking_changes_allowed: false` for the existing `copilot-sdk` and `pi` harnesses. The acceptance criteria say not to regress them. This is an addition to the code-owned `harnesses` map. Existing behaviour that must stay the same:

- `harnessFor` validation for `copilot-sdk` and `pi`.
- The `harnessContract` suite in `contract.ts`, which the other adapters also run.
- The `PLANNER_TOOL_NAMES` boundary in `chat/service.ts`.
- The Pi patch and Pi's result tool.

---

## 1. Codebase facts (verified this session)

### Harness selection — `apps/server/src/harness/harnesses.ts`

- The map is `harnesses = { "copilot-sdk": createCopilotSdk, pi: createPiHarness }`. Its `satisfies` type is `(settings: {credentials, limits, auth?}) => HarnessV1` (lines 17-27).
- The cached singleton is `selected: HarnessV1 & { shutdown(): Promise<void> }` (line 31). `shutdownHarnesses()` calls `selected?.shutdown()` (lines 89-93).
- `loopback()` accepts `localhost`, `::1`, `[::1]` and `127.x.x.x` (lines 33-37).
- Pi auth modes are `PI_AUTH_MODES = {auto, openai, anthropic, custom, ai-gateway}` (line 42). `harnessFor` for Pi (lines 54-63) does three things:
  - requires `HARNESS_AUTH`;
  - rejects unknown modes;
  - allows only `ai-gateway` on a non-loopback host.
- Every other harness goes through the generic rule: an auth value other than `direct` or `ai-gateway` needs loopback (lines 64-66). An `atomic` branch is needed, or `atomic` will silently use the generic rule.
- `createPiHarness` forwards only `auth` (lines 11-15). The Atomic factory should follow the same pattern; credit `limits` are Copilot-specific.

### Tests to update — `harnesses.test.ts`

- Line 8 pins `Object.keys(harnesses)` to `["copilot-sdk", "pi"]`. It must become `["copilot-sdk", "pi", "atomic"]`, or whatever order registration uses.
- Add the Atomic auth-mode and loopback matrix in the same style as the Pi tests at lines 28-47.

### Shared contract — `apps/server/src/harness/contract.ts`

`harnessContract(name, createHarness, createSandboxSession?)` has three tests:

1. **Tools boundary** (prompt `"tools"`, host tools `first_host` and `second_host`):
   - the turn sees exactly the host tools;
   - `builtinTools` is empty, or `supportsBuiltinToolFiltering` is true with `builtinToolFiltering: {mode:"allow", toolNames:[]}`;
   - no non-host `tool-call`/`tool-result` events appear;
   - destroy runs once.
2. **Structured output** (prompt `"output"`, `Output.object({answer: string})`): `result.output` parses and `responseFormat.type === "json"` is forwarded.
3. **Abort** (prompt `"abort"`): `abortSignal` is forwarded as the same object; after abort `hasUnfinishedTurn()` is false; destroy is idempotent.

The suite does **not** test a plain text turn, and it does not force a host-tool round trip. Criterion 6 requires both, so `atomic.contract.test.ts` needs extra cases. Recommendation: script the stub so `"tools"` makes a call to `first_host` and then returns text, and add an explicit `"plain"` text test. `contract.ts` is shared with `copilot-sdk` and `pi`; changing it risks regressing them.

### Pi reference — `apps/server/src/harness/pi.contract.test.ts` and `pi/model-stub.ts`

- **The stub:**
  - It is an OpenAI-completions SSE server.
  - It is scripted by the last user message and `hasPriorToolResult`, which is true when any message has `role: "tool"`.
  - It supports `text`, `tool` and `hold` turns; `hold` closes the response on request abort.
  - It records `prompt`, `system`, `toolNames` and `hasPriorToolResult` for each request.
- **Pi's extra tests** can be copied almost directly:
  - one model request on a structured turn;
  - no result tool offered on a plain turn;
  - a rogue result-tool call is blocked and kept out of the stream;
  - quoted earlier chat does not enable the tool;
  - host `AGENTS.md` isolation;
  - an unknown model fails with no model request.
- **Stub caveat (seen in the spike):** `hasPriorToolResult` scans the whole history. An Atomic session keeps multi-turn history, so any later turn in a session that already made a tool call gets `"Done."`. Each contract case uses a fresh `HarnessAgent` session, so that is fine. Multi-turn unit tests need a fresh session per scenario or a stub keyed differently.

### Pi's result-tool approach — `apps/server/src/harness/pi/adapter.ts`

- `piResultToolExtension(state)` (lines 53-80):
  - registers a `Type.Object({}, {additionalProperties:true})` tool that returns `terminate: true`;
  - on `before_agent_start`, adds or removes the tool from the active set based on `state.structured`;
  - on `tool_call`, blocks the tool when the turn is not structured.
- `runOutputTurn` (lines 106-191):
  - reserves the result tool's name;
  - hides the result tool's parts;
  - in JSON mode drops prose, reasoning and inner `finish-step`s;
  - on `finish`, emits `text-start`/`text-delta`/`text-end` with the JSON and one synthetic `finish-step`;
  - rejects `done` when no result or an invalid result arrived.
- The extension is typed against Pi's `ExtensionAPI` from `@earendil-works/pi-coding-agent`. Atomic's `ExtensionAPI` has the same members (`registerTool`, `on("before_agent_start")`, `on("tool_call")`, `getActiveTools`, `setActiveTools`) but they are different TypeScript types (`dist/core/extensions/api-types.d.ts:54,71,77,146,150`).
- Recommendation: write an Atomic-typed twin of the extension, or share only the name, instruction text and stream-suppression helpers. Forcing one generic type over two different overload sets is likely to fight `tsgo`.

### Copilot reference — `apps/server/src/harness/copilot-sdk/adapter.ts`

- **Host tools** (lines 180-212): the handler emits `tool-call`, parks a resolver keyed by `toolCallId`, then on `submitToolResult` emits `tool-result` and throws when `isError` is set.
- **Terminal result tool** (lines 214-231): it emits the JSON as text.
- **Fail-closed check** (lines 107-138): `assertHostOnly` compares live tool metadata with exactly the host names and logs `[agent] N tools: …`. AGENTS.md "Diagnostics" expects this kind of log.
- **Abort** (lines 435-447): resolves every pending tool with an error, then settles.
- **Unsupported methods** (lines 472-476): continue, suspend, detach and stop throw `HarnessCapabilityUnsupportedError`. Criterion 1 requires the Atomic adapter to go further; see §3.
- **Defaults:** `builtinTools: {}` and `supportsBuiltinToolFiltering: true` (lines 279-280). The Atomic adapter should declare the same.

### How Chopin uses harnesses (subagent report, spot-checked)

- **Planner:** `service.ts:891-901` and `session.ts` open **one HarnessAgent session per chat turn** and destroy it in `finally` (I read `service.ts:1020-1060`).
- **Workers:**
  - The summary worker runs **several `generate` turns on one worker session** with `output` (I read `document-summary.ts:225-260`).
  - Research workers use `structuredAgent`, which has `output` plus an optional `web_search` host tool (`agents.ts:94-125`).
  - So the Atomic adapter must support multi-turn sessions and a host-tool round trip inside a structured turn.
- **`translate()`** (`chat/service.ts` ~1156-1272):
  - a `tool-call` outside `PLANNER_TOOL_NAMES` aborts the turn with a boundary failure;
  - `tool-approval-request` aborts;
  - `error` parts are posted to chat.
- Nothing in Chopin calls `continueStream`, `stop`, `detach` or `doCompact` in production (grep of `apps/server/src`). Continue and stop are required only by the contract.
- **`config.ts:49-58`:** `DEFAULT_MODEL = "gpt-6-luna"`, and `MODEL` is required only for `HARNESS=pi`. In the spike, Atomic's catalog contains `github-copilot/gpt-6-luna`, but a bare `gpt-6-luna` has no provider. Mirroring the Pi rule for `atomic` is my proposal; it is not a contract clause.

### Packages

- The root `package.json` `catalogs.harness` has no `@bastani/atomic`. Add `"@bastani/atomic": "0.9.23"` there and `"@bastani/atomic": "catalog:harness"` in `apps/server/package.json`.
- `bun.lock` has no `@bastani` entries. `node_modules/.bun/@bastani+atomic@0.9.20-alpha.5` is stale, left over from an older branch; the lockfile will be regenerated.
- `npm view` confirms `latest = 0.9.23`, published 2026-09-27. It depends on `typebox 1.3.27`, while Chopin's catalog pins `1.3.7`. TypeBox's `TSchema` is an empty interface (`typebox/build/type/types/schema.d.mts:1`), so the mismatch should be type-compatible, but that is unverified in `tsgo`.
- The package is 41 MB unpacked, with heavy dependencies: `embedded-postgres`, `@dbos-inc/dbos-sdk`, `pg`, platform natives for linux-x64/arm64 gnu/musl, darwin and win32. There is no `postinstall`. Expect a noticeably larger Docker image; the `oven/bun` Debian base should use the gnu natives.

### Lint and format

- `.oxlintrc.json` restricts `@github/copilot-sdk` imports to `harness/copilot-sdk/`. A matching restriction for `@bastani/atomic` to `harness/atomic/` would follow convention; that is my proposal, not a requirement.
- `dprint.json` sets tabs, width 100 and double quotes.
- `bun run ci` runs `dprint check && oxlint && bun scripts/check-tokens.ts`; the token check only inspects CSS.

### History

- Branch `backup/main-before-atomic-rewind` (commit `49419cf`) holds an earlier Atomic SDK backend, from before the move to the `HarnessAgent` architecture:
  - `apps/server/src/agent/atomic.ts` and `events.ts`;
  - an inert custom `ResourceLoader`, `builtins` all false, an `AMBIENT` tool denylist;
  - `resolveAtomicModel` built on `runtime.getModel`;
  - an `abortEpoch` guard so an abort is not reported as a provider error.
    It is useful prior art, but it was written against 0.9.20-alpha.5 and a Copilot-shaped event bridge.
- Relevant `User-preference` trailers:
  - "Prefer an upstream-supported extension point over working around third-party adapter races" (`a3ab603`);
  - "Patch pinned dependencies with bun patch when the upstream adapter exposes no option for a needed safety fix" (`c9d8a9f`);
  - "Record third-party harness limitations as documented caveats rather than patching dependencies" (`2c83ef3`).
- Trailers are formatted as in `0943098` and `45889b6`: `Assistant-model`, `Assistant-workflow`, one `Assistant-verification: <method> <passed|failed>: <detail>` per check, and `Co-authored-by: Alex Lavaee <lavaman131@github.com>`.
- Comparable harness-adapter durations from the `harness-stack` records: 95m (Pi admit), 92m, 70m, 61m, 30m, 28m (blocked). The median is about 65m over 6 records. Most ran over their estimates.

---

## 2. Atomic SDK 0.9.23 facts

Paths are under `/home/alexlavaee/.bun/install/global/node_modules/@bastani/atomic/dist/`.

### Session assembly — `core/sdk.js`, `core/sdk-types.d.ts`

- **`builtins`:**
  - Shipped packages are on unless a key is explicitly `false` (`sdk-types.d.ts:11-14`).
  - A custom `resourceLoader` is wrapped in `BuiltinResourceLoader`, which adds the shipped packages whatever the loader's `no*` flags say (`sdk.js:161-164`).
  - Intercom is **mandatory**: it is added by `withMandatoryResourceLoader` unless `builtins.intercom === false` (`sdk.js:165-167`, `mandatory-resource-loader.js:11-27`).
  - Spike ("loose" mode, with the tools allowlist but default builtins): the active tools stayed limited to the allowlist, but all five builtin extension bundles loaded and ran their startup code, and the run was much slower. So all five keys must be `false`; an allowlist alone is not enough.
- **Tools** (`sdk.js:238-243`, `agent-session-tool-registry.js:17-37,80-85`):
  - `tools` omitted: the default coding tools are active, plus every extension tool. Spike "notools" mode listed read, bash, kill, edit, write, find, search, ask_user_question, todo, workflow, subagent, web_search, code_search, fetch_content, get_search_content, intercom and mcp.
  - `tools: [...]`: only the named tools are even registered, and **both custom and extension tools must be named**. Every registered allowed tool is re-activated whenever the registry refreshes.
  - `noTools: "all"` exposes nothing.
  - A custom tool named `intercom` is dropped.
- **Model:** there is no lookup when `model` is passed. When it is `undefined`, `findInitialModel` silently picks a preferred or first-available model (`sdk.js:182-211`).
  - Spike: `runtime.getModel("stub","nope")` returned `undefined`. Passing that through produced a session on `stub/stub-model` with `modelFallbackMessage: undefined`.
- **Defaults to override:**
  - `fallbackModels` defaults to `settings.fallbackModels`. `SettingsManager.inMemory` makes that `[]`; pass `fallbackModels: []` explicitly anyway.
  - `agentDir` defaults to `$ATOMIC_CODING_AGENT_DIR` → `$PI_CODING_AGENT_DIR` → `~/.atomic/agent`.
  - Creation always calls `modelRuntime.refresh({allowNetwork:false})`.
- **`systemPromptTransform`** exists but applies only at construction.
- **`createStructuredOutputTool`** runs a second `streamSimple` request (`core/tools/structured-output.js:60-71`). Do not use it; criterion 4 forbids it.

### Resource loader — `core/resource-loader-reload.js`, `resource-loader-types.d.ts:113-167`

- The flags `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes` and `noContextFiles` gate discovery (`reload.js:204-211, 224, 259-261, 276-278, 297-299, 314-322`).
- `additional*Paths` and CLI paths still load when the flags are set. Leave them empty.
- `extensionFactories` load even with `noExtensions`.
- `SYSTEM.md` and `APPEND_SYSTEM.md` are discovered unless `systemPrompt` or `appendSystemPrompt` is given (`reload.js:329-341`). Pass `appendSystemPrompt: []`.
- **Empty system prompt trap:** `systemPrompt: ""` is not nullish, so discovery is skipped, but `buildSystemPromptSections` treats `""` as missing (`system-prompt.js:105-115`). The result is Atomic's default preamble: "expert coding assistant…", the tools list, the guidelines, and an "Atomic documentation" section.
  - Spike with `SPIKE_SP=""`: "Atomic documentation" and "expert coding assistant" were both present.
  - HarnessAgent turns with no `instructions`, including all three shared contract cases, hit this unless the adapter forces the prompt.
- Even with a custom prompt, Atomic adds `<model>`, `<date>` and `<cwd>` sections (`system-prompt.js:139-141`).
- **Forcing the prompt:** a `before_agent_start` handler that returns `{systemPrompt}` sets `forceSystemPrompt` (`extensions/runner-events.js:324`). Spike: the model received exactly `"FORCED-TURN-PROMPT"` on every turn. This is the upstream-supported hook for per-turn instructions without reloading resources.

### Isolation checked in the spike

- **Setup:** a temporary `HOME` containing `~/.atomic/agent/{AGENTS.md, SYSTEM.md, APPEND_SYSTEM.md, settings.json (defaultTools, fallbackModels), extensions/evil.ts, skills/, prompts/}`, `~/.pi/agent/AGENTS.md` and `~/.agents/skills`. The working directory held `AGENTS.md`, `CLAUDE.md`, `.atomic/extensions`, `.pi/extensions` and `.agents/skills`.
- **Configuration:** `DefaultResourceLoader` with all `no*` flags, `systemPrompt`, `appendSystemPrompt: []` and one inline factory; `SettingsManager.inMemory`; `SessionManager.inMemory(cwd)`; all five builtins `false`; `tools: [host, RESULT]`.
- **Results:**
  - The only extension was `<inline:1>`.
  - Active and registered tools were exactly the host tool and the result tool.
  - No marker text reached the system prompt the stub received.
  - **No files were created or modified under the temporary `HOME` or cwd** (`find -newer marker` was empty).

### Events — spike traces

| Scenario                            | Event sequence                                                                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain turn                          | `agent_start turn_start message_start/end:system message_start/end:user message_start:assistant message_update:text_start/text_delta/text_end message_end:assistant:stop turn_end agent_end agent_settled`            |
| Host tool                           | `…message_update:toolcall_start/delta/end message_end:assistant:toolUse tool_execution_start:host_a tool_execution_end:host_a message_start/end:toolResult turn_end turn_start …text… agent_end` — two model requests |
| Terminating tool                    | one model request; `tool_execution_*:RESULT`, then `agent_end` with no second assistant message; the last message is a `toolResult`                                                                                   |
| Blocked result tool on a plain turn | `tool_execution_start/end:RESULT:err`, then the model continues — these parts must be kept out of the stream                                                                                                          |
| Hallucinated `bash`                 | `tool_execution_start/end:bash:err`, "tool not found" handled inside Atomic                                                                                                                                           |
| Abort                               | `prompt()` **resolved** without throwing; `agent.state.errorMessage = "Request aborted"`; last assistant `stopReason: "aborted"`; `agent_end` still fires                                                             |

- **Abort during a pending host tool:**
  - If `execute` honours `signal`, abort settles in about 200 ms with `errorMessage "The operation was aborted."` and `tool_execution_end:err`.
  - If `execute` ignores `signal`, **`abort()` and `prompt()` hang** (killed by a 20 s timeout).
- **Other facts:**
  - `AgentToolResult` has no `isError`. A throw from `execute` becomes `isError`.
  - `tool_call` handler errors **block** execution, which fails closed (`agent-session-tool-hooks.js:13-33`).
  - `before_agent_start` handler errors are only reported through `emitError` and **do not fail the turn** (`extensions/runner.js:655`). Fail-closed checks therefore belong in the adapter, not in a throwing hook.
- **Other prompt paths:**
  - `prompt()` runs `/…` text as an extension command, and expands skill and template syntax, unless `expandPromptTemplates: false` (`agent-session-prompt.js:93-103, 143-147`). Pass `false`.
  - Missing auth throws before any request (`agent-session-prompt.js:187-200`).
- **Oversized results:** results over `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000` (`core/tools/tool-limits.js:17`) are persisted to a session temp directory. An in-memory `SessionManager` has an empty session dir, so the OS temp dir is used. The model then receives a preview and a path it cannot read (`agent-session-tool-hooks.js:69`, `tools/oversized-tool-result.js:276-313`). Setting `maxResultSizeChars: Infinity` on host `ToolDefinition`s opts out.

### Settings defaults that matter (`core/settings-manager-basic-accessors.js`)

| Setting                  | Default           | Effect                                        |
| ------------------------ | ----------------- | --------------------------------------------- |
| `compaction.enabled`     | `true`            | Extra summarization model calls               |
| `retry.enabled`          | `true`, 3 retries | Automatic retries                             |
| `cacheWarming`           | `"streaming"`     | Extra cache-refresh requests to the provider  |
| `sessionSummary.enabled` | `true`            | Skipped in SDK "print" mode, per the subagent |

Suggested in-memory settings: `{ compaction: {enabled:false}, cacheWarming: "off", sessionSummary: {enabled:false} }`, plus explicit `fallbackModels: []`. Keeping `retry` on is a judgement call.

### Auth — `core/model-runtime.js:86-117`, `core/auth-storage*.js`, `@bastani/pi-ai/dist/env-api-keys.js`

- `ModelRuntime.create({ credentials?, authPath?, modelsPath?: string|null, refreshOnCreate?, allowModelNetwork? })` has no `providers` option. Register custom providers with `runtime.registerProvider(id, {baseUrl, apiKey, api:"openai-completions", models:[…]})`; this worked in the spike.
- **Default credentials** are file-backed and layered: `~/.atomic/agent/auth.json` and `~/.pi/agent/auth.json`. `FileAuthStorageBackend.withLock` makes the parent directory. OAuth and key updates write `auth.json` atomically (`auth-storage.js:30-122`, `auth-storage-backends.js:20-80`). `readStoredCredential` also goes through `withLock`.
- **`AuthStorage.inMemory(data)`** never touches disk. `modelsPath: null` avoids `models.json` and `models-store.json`.
- **Environment keys still resolve with in-memory credentials.** Spike with `ANTHROPIC_API_KEY=dummy` and `AI_GATEWAY_API_KEY=dummy2`: `hasConfiguredAuth("anthropic")` and `("vercel-ai-gateway")` were true; without them both were false.
- pi-ai also treats ambient **AWS profile/IAM** credentials (for `amazon-bedrock`) and **gcloud ADC** at `~/.config/gcloud/…` (for `google-vertex`) as configured auth. Those are host-logged-in cloud credentials even in an "env-only" mode.
- `ReadOnlyAuthStorage` exists (`auth-storage.js:123`) but is **not exported** from the package root. `getAgentConfigPaths` and `AuthStorage` are exported (`index.d.ts:14,16`).
- The Harness auth vocabulary is `HarnessV1Authentication<C> = 'auto' | 'ai-gateway' | C | Record<string,string>` (`@ai-sdk/harness/src/v1/harness-authentication.ts:15-24`).

---

## 3. Implementation guidance

These are proposals. Where the contract does not fix a choice, it is marked **(decision)**.

### Files

- `apps/server/src/harness/atomic/adapter.ts`: `createAtomicAdapter(settings)` returning `HarnessV1 & { shutdown(): Promise<void> }`, with `harnessId: "atomic"`, `builtinTools: {}` and `supportsBuiltinToolFiltering: true`.
- An optional `apps/server/src/harness/atomic/auth.ts` for mode handling.
- `apps/server/src/harness/atomic/adapter.test.ts`.
- `apps/server/src/harness/atomic.contract.test.ts`, importing `../pi/model-stub` or `./pi/model-stub`.
- `harnesses.ts`: `atomic: createAtomicHarness`, forwarding only `auth`, plus an `atomic` branch in `harnessFor`. Also update `harnesses.test.ts`.
- `package.json` catalog and `apps/server/package.json`; regenerate `bun.lock`.
- Optional: `config.ts` and `config.test.ts` to require `MODEL` for `atomic`; an `.oxlintrc.json` import restriction.

### Session creation

- Create the Atomic session lazily on the first turn, or in `doStart`. Each HarnessV1 session owns one `AgentSession`.
- Options:
  - `cwd`: a fresh `mkdtemp` directory removed in `doDestroy`. Do not use the sandbox's virtual `sessionWorkDir` or `process.cwd()`.
  - `agentDir`: that same empty temp directory.
  - `modelRuntime`: built per the auth mode.
  - `model`: the resolved model; `thinkingLevel: "off"` or a setting **(decision)**.
  - `fallbackModels: []`.
  - `sessionManager: SessionManager.inMemory(cwd)`; `settingsManager: SettingsManager.inMemory({...})` per §2.
  - `builtins: { workflows:false, subagents:false, mcp:false, "web-access":false, intercom:false }`.
  - `tools: [...hostNames, RESULT_TOOL]`.
  - `customTools`: host tools defined with `defineTool`, `Type.Unsafe(spec.inputSchema ?? {type:"object"})` and `maxResultSizeChars: Infinity`.
- The loader is `new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory({}), noExtensions, noSkills, noPromptTemplates, noThemes, noContextFiles: true, systemPrompt: <non-empty>, appendSystemPrompt: [], extensionFactories: [resultToolExtension(state)] })`.
- **Rebuild or refuse** **(decision):** if a later turn changes the host tool set, the session must be rebuilt, because only allowlisted tools are registered. Pi rebuilds on a tool-signature change; Copilot uses a fresh session per turn. Model changes can use `session.setModel` after checking.

### Fail-closed checks

Before every `prompt()`, and throw before any model request if a check fails:

- `created.extensionsResult.extensions` must be exactly the one inline factory.
- The names from `session.getAllTools()` must equal `host ∪ {RESULT}`.
- After `setActiveToolsByName(expected)`, `getActiveToolNames()` must equal `expected`, where `expected = structured ? [...host, RESULT] : host`.
- `session.model` must match the requested provider and id.
- Log `[agent] N tools: …` like Copilot does.

During the turn: treat `tool_execution_start` for a name outside `host ∪ {RESULT}` as a boundary event. **(decision):** either abort with an `error` part, or let Atomic's "tool not found" stand and never emit it. The spike shows Atomic already refuses unknown names without running anything, and emitting it would make `chat/service.ts` abort the turn anyway.

### Per-turn prompt and structured output

- The result extension, following `piResultToolExtension`, uses `on("before_agent_start")` to:
  1. `setActiveTools(expected)`;
  2. return `{ systemPrompt: <turn.instructions, plus the result instruction and schema when structured, or a neutral non-empty prompt> }`.
- `on("tool_call")` blocks `RESULT` unless `state.structured`.
- The adapter sets `state.structured` from `turn.responseFormat?.type === "json"`, never from prompt text. It reserves the `RESULT` name against host tools, as Pi and Copilot do.
- `RESULT.execute(id, params)` captures `params` in adapter state and returns `terminate: true`.
- On `agent_end`, if a result was captured, emit `text-start`/`text-delta(JSON.stringify(params))`/`text-end`, then `finish-step` and `finish`. If not, reject `done` with "Atomic turn ended without a structured result."
- In JSON mode, drop prose and reasoning, as both existing adapters do.
- The spike confirmed one model request for a structured turn. Keep the Pi-style result-tool schema, `Type.Object({}, {additionalProperties:true})` with the schema written into the instruction, or use `Type.Unsafe(responseFormat.schema)` with a rebuild when the schema changes **(decision)**. Either way HarnessAgent validates host-side.
- Workers need a `web_search` round trip inside a structured turn to keep working. The name `web_search` no longer collides with anything once `web-access` is off.

### Stream translation (only what `translate()` and HarnessAgent consume)

- `message_update` with `text_start`/`text_delta`/`text_end` on assistant messages maps to `text-start`/`text-delta`/`text-end` with a stable id per content block. `thinking_*` maps to `reasoning-*` (optional). Ignore `system`, `user` and `toolResult` messages.
- **Host tool round trip:** inside `execute`:
  1. emit `tool-call {toolCallId, toolName, input: JSON.stringify(params)}`;
  2. park a resolver, and race it against `signal`, **mandatory** per the spike;
  3. on `submitToolResult`, emit `tool-result {…, result, isError}`;
  4. return `{content:[{type:"text", text: serialize(output)}]}`, or throw when `isError`.
     Never emit parts for `RESULT` or for blocked or unknown tools.
- At the end of `prompt()`, inspect the last assistant message:
  - `stopReason: "aborted"`, or the abort signal is set: settle quietly or with an abort error. The HarnessAgent `settleFailure` path turns it into an `abort` part, and `hasUnfinishedTurn` is false.
  - `stopReason: "error"` or `agent.state.errorMessage` set: emit an `error` part and reject `done`.
  - Otherwise emit `finish-step` and `finish` with `stop`. Usage can come from the assistant message's `usage` or be zeroed as Copilot does.
  - `prompt()` preflight throws, such as missing auth, reject `done`.
- **Abort:**
  - `turn.abortSignal` calls `session.abort()`;
  - settle every pending resolver with an error;
  - bound the wait as Copilot's `bounded()` does;
  - ignore late `submitToolResult` calls.

### Remaining lifecycle

- **`doContinueTurn`:** the in-process equivalent of Pi's live-turn path (§4): if a turn is active, re-point `emit` and return the live control. Otherwise **(decision)**: throw `HarnessCapabilityUnsupportedError`, or run `session.agent.continue()`. `agent` is reachable, but `continue()` is not part of the public session surface.
- **`doStop` / `doDetach`:** tear down and return `{type:"resume-session", harnessId:"atomic", specificationVersion:"harness-v1", data:{}}`, with `isResume: false`. The in-memory session cannot resume across processes, so document that as a caveat.
- **`doSuspendTurn`:** a lossy `continue-turn` or unsupported **(decision)**.
- **`doCompact`:** unsupported, since compaction is off.
- **`doDestroy`:** idempotent — abort, settle pending tools, `session.dispose()`, remove the temp dir.
- **`shutdown()`:** dispose live sessions or no-op. There is no global Atomic runtime unless one shared `ModelRuntime` is kept.
- **`skills`:** Chopin always passes `[]`. Rejecting non-empty skills keeps the "no skills" guarantee explicit **(decision)**.

### `HARNESS_AUTH` for `atomic` (decision; evidence above)

Proposal, following the Pi pattern and the `HarnessV1Authentication` vocabulary. `HARNESS_AUTH` is required; unknown values are refused.

| Mode                                   | Credentials                                                                                                                                                                                                                   | Allowed bind                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `auto`                                 | A snapshot of the host Atomic login loaded into `AuthStorage.inMemory(...)` — not the file-backed store, so a refresh cannot write to disk — plus environment keys                                                            | Loopback only                                                                                    |
| `ai-gateway`                           | `AuthStorage.inMemory()`, `modelsPath: null`, `AI_GATEWAY_API_KEY`; resolved models should be restricted to provider `vercel-ai-gateway`, because other env keys and ambient AWS/GCP credentials would otherwise be picked up | Any                                                                                              |
| env-key mode (optional, e.g. `direct`) | In-memory credentials with named provider environment keys                                                                                                                                                                    | Any only if `amazon-bedrock`/`google-vertex` ambient credentials are refused; otherwise loopback |

- Reading the host login snapshot without writes means reading the JSON from `getAgentConfigPaths("auth.json")` yourself. `AuthStorage.create` and `readStoredCredential` go through `withLock`: that makes a directory and a lock file but writes no credentials.
- Refresh-token rotation that stays in memory may invalidate the host CLI's stored refresh token. Record that as a caveat.
- `api_key` entries using `!command` run a shell command when resolved. Caveat for `auto`.

### Model resolution (criterion 3)

- Take `turn.model`, falling back to an adapter `settings.model` for tests.
- Require `provider/id` and call `runtime.getModel(provider, id)`. If it is missing, throw `Atomic does not recognize model <id>` **before** any request, matching Pi's wording.
- Never pass `undefined` to `createAgentSession`, because that is exactly the silent fallback.
- When no model is given at all: fail **(decision)**. The contract suite needs the stub adapter to set a default model.

---

## 4. Testing and verification

### `atomic.contract.test.ts`

- Stub script:
  - `"tools"` → a call to `first_host`, then `"Done."`;
  - `"output"`/`"rogue"` → a call to `RESULT` with `{"answer":"yes"}`;
  - `"abort"` → hold;
  - anything else → text.
- Adapter setup: `auth` set to an isolated in-memory configuration, plus a registered `stub` provider (`apiKey:"stub-key"`, `api:"openai-completions"`) and `model: "stub/stub-model"`.
- Cases:
  - `harnessContract("atomic", …, createJustBashNetworkSandboxSession)`;
  - a plain text turn;
  - a host round trip, asserting two requests with `hasPriorToolResult` `[false, true]` and `tool-call`/`tool-result` for `first_host`;
  - one request for a structured turn, with `RESULT` offered;
  - `RESULT` not offered on a plain turn;
  - rogue `RESULT` blocked and hidden;
  - quoted instruction text does not enable `RESULT`;
  - host `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md` and skills stay out of the `system` the stub saw, using a temporary cwd or `HOME` and agent dir;
  - an unknown model rejects with zero stub requests;
  - the tool boundary: the active and registered tool names equal the host tools, and the system prompt contains no "Atomic documentation" or "expert coding assistant" text on a turn without instructions;
  - abort during a pending host tool completes.

### `atomic/adapter.test.ts`

Unit tests in the style of `pi/adapter.test.ts`, using a fake extension API or a fake session:

- result-tool state switching;
- the stream-suppression helper;
- `done` rejections: no result, invalid result, error `stopReason`;
- the reserved result-tool name;
- the auth-mode and settings mapping.

### `harnesses.test.ts`

- the map keys include `atomic`;
- missing, unknown and loopback cases for each Atomic mode.

### Gates

Run in this order, recording one `Assistant-verification` line per command:

1. `bun run fix`, then inspect the diff;
2. `bun test`, with `bun test apps/server/src/harness` first for speed;
3. `bun run types`;
4. `bun run ci`.

Past records show about 1,566 passing tests plus 2 PostgreSQL skips as the baseline. E2E is not required, but the Docker job in CI will pick up the larger dependency tree; `docker build` locally is optional.

---

## 5. Documentation to update

- **`docs/hosted-agent.md`:**
  - lines 13-19: the harness list;
  - lines 21-36: ownership — under `atomic`, the owner supplies only the GitHub token and model access comes from `HARNESS_AUTH`;
  - lines 46-67: runtime isolation — builtins off, inert loader, forced system prompt, fail-closed tool check;
  - the code map near line 209.
- **`docs/self-hosting.md`:**
  - lines 56-122, "Choose and trust a harness": the Atomic auth modes and loopback rule, `MODEL` as `provider/id`, the result tool, caveats;
  - line 131 onward: prerequisites;
  - the environment table rows for `MODEL`, `HARNESS`, `HARNESS_AUTH` and `SERVER_HOST`;
  - the sample environment and startup checks.
- **Also:** `.env.example` lines 5-17, `docs/architecture.md` (lines 6, 36, 56, 112-124, 473-477 name "Copilot or Pi"), and `README.md` lines 73-84 and 104.
- **AGENTS.md** does not list harnesses by name. The "Harness and Planner" failure traps (lines 280-299) should gain an Atomic entry: the empty-prompt preamble, abort-signal hangs, and `prompt()` resolving on abort.

**Atomic caveats to document:**

- the silent model fallback, which the adapter guards;
- the default coding-agent preamble when no prompt is given;
- the mandatory Intercom unless disabled;
- the 50 KB tool-result spill to temp files;
- environment and ambient cloud credentials are read even in isolated mode;
- `auto` refresh stays in memory and can rotate the host token;
- no resume across processes;
- no Copilot-style per-session credit limit, so workers' `maxAiCredits` is ignored;
- the package size;
- `typebox` 1.3.7 vs 1.3.27.

## 6. Open items and limits

- I did not verify `tsgo` compatibility of Chopin's `typebox` 1.3.7 schemas with Atomic's `ToolDefinition<TSchema@1.3.27>`, or that `bun install` resolves 0.9.23 cleanly in this workspace.
- I did not trace the exact OAuth refresh call site that writes `auth.json` in the file-backed mode.
- I did not observe how HarnessAgent reacts to a `tool-call` emitted from inside `execute` while other parallel calls in the same batch are pending. Atomic schedules "shared" tool calls concurrently; add a test with two host calls in one message.
- I did not test `session.agent.continue()` for `doContinueTurn`.
- I did not write the research-codebase skill's `research/docs/` file, to keep the repository untouched for the implementation commit. This message is the artifact.
