import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentAiEnvironment,
	atomicModels,
	managedEnvironment,
	withoutOwnerAgent,
} from "./ai-agent";

let scratch = mkdtempSync(join(tmpdir(), "chopin-ai-agent-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROVIDERS = [
	{
		provider: "github-copilot" as const,
		baseUrl: "https://chopin.test/api/v1/ai/github-copilot",
		placeholder: "chopin_ai_copilot",
		keyVariable: "COPILOT_GITHUB_TOKEN",
	},
	{
		provider: "openai" as const,
		baseUrl: "https://chopin.test/api/v1/ai/openai/v1",
		placeholder: "chopin_ai_openai",
		keyVariable: "OPENAI_API_KEY",
	},
];
const RELAYED = {
	baseUrls: {
		"github-copilot": "http://127.0.0.1:9/k/github-copilot",
		openai: "http://127.0.0.1:9/k/openai",
	},
	catalogUrl: "http://127.0.0.1:9/k/models.dev",
};

test("leaves out the owner's model credentials and agent directories, and keeps everything else", () => {
	expect(
		withoutOwnerAgent({
			OPENAI_API_KEY: "sk-owner",
			anthropic_api_key: "sk-ant-owner",
			COPILOT_GITHUB_TOKEN: "ghp_owner",
			ATOMIC_CODING_AGENT_DIR: "/home/owner/.atomic/agent",
			CLAUDE_CONFIG_DIR: "/home/owner/.claude",
			OPAQUE_API_KEY: "kept",
			PATH: "/usr/bin",
		}),
	).toEqual({ OPAQUE_API_KEY: "kept", PATH: "/usr/bin" });
});

test("gives an Atomic agent a state directory of its own, with a models.json that reads each stand-in from its variable", () => {
	let home = join(scratch, "atomic-run.agent");
	let env = agentAiEnvironment({
		command: ["/usr/local/bin/atomic-acp"],
		home,
		providers: PROVIDERS,
		relayed: RELAYED,
	});
	expect(env).toEqual({
		ATOMIC_CODING_AGENT_DIR: join(home, "atomic"),
		PI_CODING_AGENT_DIR: join(home, "atomic"),
		COPILOT_HOME: join(home, "copilot"),
		CLAUDE_CONFIG_DIR: join(home, "claude"),
		CODEX_HOME: join(home, "codex"),
		ATOMIC_MODEL_CATALOG_URL: RELAYED.catalogUrl,
		CHOPIN_AI_PROVIDERS: expect.any(String),
		COPILOT_GITHUB_TOKEN: "chopin_ai_copilot",
		OPENAI_API_KEY: "chopin_ai_openai",
		OPENAI_BASE_URL: RELAYED.baseUrls.openai,
	});
	// Each provider's base URL on the relay with its stand-in, together, Copilot's headers with it.
	expect(JSON.parse(env.CHOPIN_AI_PROVIDERS!)).toEqual([
		{
			provider: "github-copilot",
			baseUrl: RELAYED.baseUrls["github-copilot"],
			apiKey: "chopin_ai_copilot",
			keyVariable: "COPILOT_GITHUB_TOKEN",
			headers: { "Copilot-Integration-Id": "vscode-chat" },
		},
		{
			provider: "openai",
			baseUrl: RELAYED.baseUrls.openai,
			apiKey: "chopin_ai_openai",
			keyVariable: "OPENAI_API_KEY",
		},
	]);
	let models = JSON.parse(readFileSync(join(home, "atomic", "models.json"), "utf8"));
	expect(models).toEqual(atomicModels(PROVIDERS, RELAYED));
	expect(models).toEqual({
		providers: {
			"github-copilot": {
				baseUrl: RELAYED.baseUrls["github-copilot"],
				apiKey: "$COPILOT_GITHUB_TOKEN",
				headers: { "Copilot-Integration-Id": "vscode-chat" },
			},
			openai: { baseUrl: RELAYED.baseUrls.openai, apiKey: "$OPENAI_API_KEY" },
			"openai-api": { baseUrl: RELAYED.baseUrls.openai, apiKey: "$OPENAI_API_KEY" },
		},
	});
	// The file names variables, never a stand-in.
	expect(readFileSync(join(home, "atomic", "models.json"), "utf8")).not.toContain("chopin_ai_");
});

test("gives a ChatGPT or Claude sign-in Atomic's subscription providers, ahead of a key, and the provider's own variables only without one", () => {
	let subscriptions = [
		{
			provider: "chatgpt" as const,
			baseUrl: "https://chopin.test/api/v1/ai/chatgpt/v1",
			placeholder: "chopin_ai_chatgpt",
			keyVariable: "CHATGPT_ACCESS_TOKEN",
		},
		{
			provider: "claude" as const,
			baseUrl: "https://chopin.test/api/v1/ai/claude",
			placeholder: "chopin_ai_sk-ant-oat01-claude",
			keyVariable: "CLAUDE_CODE_OAUTH_TOKEN",
		},
	];
	let relayed = {
		baseUrls: {
			...RELAYED.baseUrls,
			chatgpt: "http://127.0.0.1:9/k/chatgpt",
			claude: "http://127.0.0.1:9/k/claude",
		},
		catalogUrl: RELAYED.catalogUrl,
	};
	let withKey = [...subscriptions, ...PROVIDERS];
	expect(atomicModels(withKey, relayed).providers).toEqual({
		openai: { baseUrl: relayed.baseUrls.chatgpt, apiKey: "$CHATGPT_ACCESS_TOKEN" },
		"openai-api": { baseUrl: relayed.baseUrls.openai, apiKey: "$OPENAI_API_KEY" },
		anthropic: { baseUrl: relayed.baseUrls.claude, apiKey: "$CLAUDE_CODE_OAUTH_TOKEN" },
		"github-copilot": {
			baseUrl: relayed.baseUrls["github-copilot"],
			apiKey: "$COPILOT_GITHUB_TOKEN",
			headers: { "Copilot-Integration-Id": "vscode-chat" },
		},
	});

	let keyed = agentAiEnvironment({
		command: ["codex"],
		home: join(scratch, "keyed.agent"),
		providers: withKey,
		relayed,
	});
	expect(keyed.OPENAI_API_KEY).toBe("chopin_ai_openai");
	expect(keyed.OPENAI_BASE_URL).toBe(relayed.baseUrls.openai);
	expect(keyed.CHATGPT_ACCESS_TOKEN).toBe("chopin_ai_chatgpt");
	expect(keyed.CLAUDE_CODE_OAUTH_TOKEN).toBe("chopin_ai_sk-ant-oat01-claude");
	expect(keyed.ANTHROPIC_BASE_URL).toBe(relayed.baseUrls.claude);

	let signedIn = agentAiEnvironment({
		command: ["codex"],
		home: join(scratch, "signed-in.agent"),
		providers: subscriptions,
		relayed,
	});
	expect(signedIn.OPENAI_API_KEY).toBe("chopin_ai_chatgpt");
	expect(signedIn.OPENAI_BASE_URL).toBe(relayed.baseUrls.chatgpt);
	expect(signedIn.ANTHROPIC_API_KEY).toBeUndefined();
	expect(signedIn.ANTHROPIC_BASE_URL).toBe(relayed.baseUrls.claude);
});

test("writes no models.json for an agent that is not Atomic, and still moves its state", () => {
	let home = join(scratch, "copilot-run.agent");
	let env = agentAiEnvironment({
		command: ["copilot", "--acp"],
		home,
		providers: PROVIDERS,
		relayed: RELAYED,
	});
	expect(env.COPILOT_HOME).toBe(join(home, "copilot"));
	expect(existsSync(join(home, "copilot"))).toBe(true);
	expect(existsSync(join(home, "atomic", "models.json"))).toBe(false);
});

test("an agent on Chopin's AI accounts starts from only what is permitted of the connector's environment, and the owner's --env without their agents' setup", () => {
	expect(
		managedEnvironment(
			{
				PATH: "/usr/bin",
				HOME: "/home/owner",
				LC_ALL: "C.UTF-8",
				https_proxy: "http://proxy:3128",
				JAVA_HOME: "/opt/java",
				MISTRAL_API_KEY: "sk-unrelated",
				SOME_SERVICE_TOKEN: "secret",
				ATOMIC_CODING_AGENT_DIR: "/home/owner/.atomic/agent",
				GH_TOKEN: "ghp_owner",
			},
			{
				SOME_FLAG: "1",
				OPENAI_API_KEY: "sk-owner",
				CLAUDE_CONFIG_DIR: "/home/owner/.claude",
				GITHUB_TOKEN: "ghp_given",
			},
		),
	).toEqual({
		PATH: "/usr/bin",
		HOME: "/home/owner",
		LC_ALL: "C.UTF-8",
		https_proxy: "http://proxy:3128",
		JAVA_HOME: "/opt/java",
		SOME_FLAG: "1",
	});
});
