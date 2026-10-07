import { expect, it } from "bun:test";

import { outputText } from "./activity";

it("redacts credential values in JSON text while retaining benign output", () => {
	let output = JSON.stringify({
		password: "synthetic-password-314",
		AWS_SECRET_ACCESS_KEY: "synthetic-aws-314",
		status: "ready",
	});
	expect(outputText(output)).toBe(JSON.stringify({
		password: "[redacted]",
		AWS_SECRET_ACCESS_KEY: "[redacted]",
		status: "ready",
	}));
});

it("redacts credentials inside a serialized JSON source without removing benign content", () => {
	let source = "```json\n"
		+ JSON.stringify({
			password: "synthetic password 314",
			AWS_SECRET_ACCESS_KEY: "synthetic-aws-314",
			region: "local",
		})
		+ "\n```";
	let result = JSON.parse(outputText(JSON.stringify({ source }))) as { source: string };
	expect(result.source).toBe(
		"```json\n"
			+ JSON.stringify({
				password: "[redacted]",
				AWS_SECRET_ACCESS_KEY: "[redacted]",
				region: "local",
			})
			+ "\n```",
	);
});

it.each([
	[
		"JSON-like text",
		"{ password: 'synthetic password 314', AWS_SECRET_ACCESS_KEY: \"synthetic-aws-314\", status: 'ready' }",
		"{ password: '[redacted]', AWS_SECRET_ACCESS_KEY: \"[redacted]\", status: 'ready' }",
	],
	[
		"environment assignments",
		'export AWS_SECRET_ACCESS_KEY=synthetic/aws+314=\nPASSWORD="synthetic password 314"\nSTATUS=ready',
		'export AWS_SECRET_ACCESS_KEY=[redacted]\nPASSWORD="[redacted]"\nSTATUS=ready',
	],
	[
		"unquoted values containing spaces",
		"password: synthetic password 314\nAWS_SECRET_ACCESS_KEY=synthetic aws 314\nstatus: ready",
		"password: [redacted]\nAWS_SECRET_ACCESS_KEY=[redacted]\nstatus: ready",
	],
	[
		"escaped quoted values",
		String.raw`{password: "synthetic \"password\", tail", path: "src/index.ts"}`,
		'{password: "[redacted]", path: "src/index.ts"}',
	],
])("redacts credential values in %s without losing benign fields", (_name, output, expected) => {
	expect(outputText(output)).toBe(expected);
});

it.each([
	["PASSWORD=synthetic,leftover;tail\nSTATUS=ready", "PASSWORD=[redacted]\nSTATUS=ready"],
	["password: synthetic,leftover\nstatus: ready", "password: [redacted]\nstatus: ready"],
	[
		"  export PASSWORD=synthetic,leftover;tail\nSTATUS=ready",
		"  export PASSWORD=[redacted]\nSTATUS=ready",
	],
	[
		"  password: synthetic;leftover,tail\n  status: ready",
		"  password: [redacted]\n  status: ready",
	],
])("redacts entire unquoted line credential values in %s", (output, expected) => {
	expect(outputText(output)).toBe(expected);
});

it.each([
	["{ password: synthetic, status: ready }", "{ password: [redacted], status: ready }"],
	["{ password: synthetic; status: ready }", "{ password: [redacted]; status: ready }"],
])("retains adjacent unquoted JSON-like fields in %s", (output, expected) => {
	expect(outputText(output)).toBe(expected);
});

it("redacts environment assignments in serialized source without double-masking placeholders", () => {
	let source = 'password="synthetic value"\nAWS_SECRET_ACCESS_KEY=synthetic-aws-314\nstatus=ready';
	expect(JSON.parse(outputText(JSON.stringify({ source })))).toEqual({
		source: 'password="[redacted]"\nAWS_SECRET_ACCESS_KEY=[redacted]\nstatus=ready',
	});
});

it("redacts the whole incomplete quoted credential in live text", () => {
	expect(outputText('password="synthetic value, remaining secret')).toBe('password="[redacted]"');
});

it("redacts credential text nested in MCP content objects", () => {
	let output = {
		content: [{
			type: "text",
			text: '{"password":"synthetic-password-314","status":"ready"}',
		}],
	};
	expect(JSON.parse(outputText(output))).toEqual({
		content: [{ type: "text", text: '{"password":"[redacted]","status":"ready"}' }],
	});
});

it.each([
	"Build completed. Password fields are documented; no credentials were returned.",
	"{ path: 'src/index.ts', status: 'ready' }",
	'{\n  "status": "ready",\n  "count": 3\n}\n',
])("retains benign output exactly: %s", output => {
	expect(outputText(output)).toBe(output);
});

it("preserves prefixed-token and Bearer masking", () => {
	let tokens = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk-"]
		.map(prefix => `${prefix}${"A".repeat(30)}`);
	let output = `${tokens.join(" ")} Bearer ${"s".repeat(30)} status=ready`;
	expect(outputText(output)).toBe(
		`${tokens.map(() => "[redacted]").join(" ")} Bearer [redacted] status=ready`,
	);
});

it.each([3_999, 4_000, 4_001, 100_000])("bounds benign output of %i characters", length => {
	let output = "x".repeat(length);
	expect(outputText(output)).toBe(length > 4_000 ? `${"x".repeat(3_999)}…` : output);
});

it("preserves and promptly bounds repeated sensitive-key identifiers without assignments", () => {
	for (let length of [3_992, 4_000, 80_000]) {
		let output = "password".repeat(length / 8);
		let start = performance.now();
		let result = outputText(output);
		let elapsed = performance.now() - start;
		expect(result).toBe(length > 4_000 ? `${output.slice(0, 3_999)}…` : output);
		expect(elapsed).toBeLessThan(250);
	}
});

it("scrubs long credential values before applying the output limit", () => {
	let output = `password="${"synthetic-314".repeat(1_000)}"\nstatus=ready\n${"x".repeat(5_000)}`;
	let result = outputText(output);
	expect(result).toStartWith('password="[redacted]"\nstatus=ready\n');
	expect(result).not.toContain("synthetic-314");
	expect(result).toHaveLength(4_000);
	expect(result).toEndWith("…");
});

it.each(["object", "serialized"])(
	"does not expose credentials beyond the %s traversal limit",
	mode => {
		let output: unknown = { password: "synthetic-deep-secret-314" };
		for (let depth = 0; depth < 8; depth++) output = { nested: output };
		let result = outputText(mode === "serialized" ? JSON.stringify(output) : output);
		expect(result).not.toContain("synthetic-deep-secret-314");
		expect(result).toContain("[redacted]");
	},
);

it("redacts punctuation-bearing credentials in line-numbered file output", () => {
	let output = "[credentials.env#ABCD]\n1:PASSWORD=synthetic,leftover;tail\n2:STATUS=ready";
	expect(outputText(output)).toBe("[credentials.env#ABCD]\n1:PASSWORD=[redacted]\n2:STATUS=ready");
});
