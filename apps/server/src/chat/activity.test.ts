import { expect, it } from "bun:test";

import { argsText, outputText, textOutput } from "./activity";
import { URL_CREDENTIAL_LEAKS } from "./activity.test-fixtures";

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

function envelope(message: string) {
	return { error: { code: "no-repository-credential", kind: "NoRepositoryCredential", message } };
}

it("retains a benign structured error and still scrubs credentials in its message", () => {
	let benign = envelope("No credential can read octo-org/score.");
	expect(outputText(benign)).toBe(JSON.stringify(benign));
	expect(outputText(JSON.stringify(benign))).toBe(JSON.stringify(benign));
	for (
		let [message, shown] of [
			["password: hunter2", "password: [redacted]"],
			[`Failed with Bearer ${"s".repeat(16)}`, "Failed with Bearer [redacted]"],
		]
	) {
		let expected = JSON.stringify(envelope(shown!));
		expect(outputText(envelope(message!))).toBe(expected);
		expect(outputText(JSON.stringify(envelope(message!)))).toBe(expected);
	}
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

it.each([
	["https://alice:hunter2@api.example.com/x", "https://[redacted]@api.example.com/x"],
	["git://alice:s3cret@example.com/r.git", "git://[redacted]@example.com/r.git"],
	["ssh://deploy:s3cret@example.com:22/r", "ssh://[redacted]@example.com:22/r"],
	["ftp://anonymous:guest@ftp.example.com/pub", "ftp://[redacted]@ftp.example.com/pub"],
	["postgres://app:pa%40ss%2Fw%3F0rd@db:5432/app", "postgres://[redacted]@db:5432/app"],
	[
		"postgresql://app:hunter2@db/app?sslmode=require",
		"postgresql://[redacted]@db/app?sslmode=require",
	],
	["mysql://root:hunter2@localhost/db", "mysql://[redacted]@localhost/db"],
	["redis://:hunter2@cache:6379/0", "redis://[redacted]@cache:6379/0"],
	["amqp://guest:gu:est@rabbit/vhost", "amqp://[redacted]@rabbit/vhost"],
	[
		"mongodb+srv://admin:p@ss@cluster0.example.net/?retryWrites=true",
		"mongodb+srv://[redacted]@cluster0.example.net/?retryWrites=true",
	],
	["https://alice:pa/ss#wo?rd@host.example/x", "https://[redacted]@host.example/x"],
	["postgres://app:hunter2@[2001:db8::1]:5432/app", "postgres://[redacted]@[2001:db8::1]:5432/app"],
	['clone "https://alice:hunter2@host/r.git" now', 'clone "https://[redacted]@host/r.git" now'],
	["clone 'https://alice:hunter2@host/r.git'", "clone 'https://[redacted]@host/r.git'"],
	["(see https://alice:hunter2@host)", "(see https://[redacted]@host)"],
	["[repo](https://alice:hunter2@host/r)", "[repo](https://[redacted]@host/r)"],
	[`https://ghp_${"A".repeat(30)}@github.com/o/r.git`, "https://[redacted]@github.com/o/r.git"],
	["https://ghs_short@github.com/o/r.git", "https://[redacted]@github.com/o/r.git"],
	["https://oauth2:glpat-synthetic@gitlab.com/o/r.git", "https://[redacted]@gitlab.com/o/r.git"],
	["https://oauth2@gitlab.com/o/r.git", "https://[redacted]@gitlab.com/o/r.git"],
	[`https://${"0123456789abcdef".repeat(2)}@github.com/o/r`, "https://[redacted]@github.com/o/r"],
	["https://sk-synthetic@api.example.com", "https://[redacted]@api.example.com"],
	["https://xoxb-synthetic@slack.example.com", "https://[redacted]@slack.example.com"],
	["https://a@host/x", "https://[redacted]@host/x"],
	// A password holding a scheme separator is masked whole, up to the last at-sign.
	["https://alice:pa://ss@host", "https://[redacted]@host"],
	["https://alice:p%3A%2F%2Fass@host", "https://[redacted]@host"],
	// The broad rule masks every userinfo that is not a short plain user name, and takes the
	// last at-sign within the window, even past a later scheme, so these non-credentials, and
	// the text between two URLs, are masked too.
	["https://alice:@example.com/x", "https://[redacted]@example.com/x"],
	["https://[::1]:8080/x@y", "https://[redacted]@y"],
	["https://example.com/search?q=a:b@c.com#x:y@z", "https://[redacted]@z"],
	[
		"https://example.com:8443/@alice and https://medium.com/@alice/post",
		"https://[redacted]@alice/post",
	],
])("masks URL credentials in plain text: %s", (output, expected) => {
	expect(outputText(output)).toBe(expected);
	expect(textOutput(output)).toBe(expected);
});

it("masks a token-carrier URL userinfo and the assignment it starts together", () => {
	// `x-access-token:` is also a credential assignment, which hides the rest of the value.
	let output = "https://x-access-token:synthetic-314@github.com/o/r";
	expect(outputText(output)).toBe("https://[redacted]");
	expect(outputText("{ token: https://alice:hunter2@host/x }")).toBe("{ token: [redacted]}");
});

it("masks a URL credential whose at-sign an assignment value would hide", () => {
	let output = "https://alice:pw;password=x@host/x";
	expect(textOutput(output)).not.toContain("alice");
	expect(outputText(output)).not.toContain("alice");
});

it("masks URL credentials in JSON-escaped text, args and results", () => {
	expect(textOutput(String.raw`{"url":"https:\/\/alice:hunter2@host\/x"}`)).toBe(
		String.raw`{"url":"https:\/\/[redacted]@host\/x"}`,
	);
	expect(outputText(String.raw`{"url":"https:\/\/alice:hunter2@host\/x"}`)).toBe(
		'{"url":"https://[redacted]@host/x"}',
	);
	expect(JSON.parse(argsText({ remote: "https://alice:hunter2@host/r.git", depth: 1 }))).toEqual({
		remote: "https://[redacted]@host/r.git",
		depth: 1,
	});
	expect(JSON.parse(argsText({ "https://alice:hunter2@host": true }))).toEqual({
		"https://[redacted]@host": true,
	});
	expect(
		JSON.parse(
			outputText({ content: [{ type: "text", text: "cloned https://alice:hunter2@host" }] }),
		),
	).toEqual({ content: [{ type: "text", text: "cloned https://[redacted]@host" }] });
});

it.each(URL_CREDENTIAL_LEAKS)("never shows a URL credential with %s", (_name, input, secrets) => {
	let views = {
		textOutput: textOutput(input),
		outputText: outputText(input),
		outputObject: outputText({ url: input }),
		argsText: argsText({ url: input }),
		argsKey: argsText({ [input]: true }),
	};
	for (let [view, shown] of Object.entries(views)) {
		for (let secret of secrets) {
			expect({ view, shown }).not.toEqual(
				expect.objectContaining({ shown: expect.stringContaining(secret) }),
			);
		}
		expect({ view, redacted: shown.includes("[redacted]") }).toEqual({ view, redacted: true });
	}
});

it.each([
	[
		"HTML entities",
		"https&#58;&#47;&#x2F;alice:hunter2&#x40;host/x",
		"https&#58;&#47;&#x2F;[redacted]&#x40;host/x",
	],
	[
		"uppercase percent-encoding",
		"HTTPS%3a%2f%2fAlice%3aHunter2%40host",
		"HTTPS%3a%2f%2f[redacted]%40host",
	],
	[
		"percent-encoded at-sign in lower case",
		"https://alice:hunter2%40host",
		"https://[redacted]%40host",
	],
	[
		"double-escaped Unicode",
		String.raw`https:\\u002f\\u002falice:hunter2\\u0040host`,
		String.raw`https:\\u002f\\u002f[redacted]\\u0040host`,
	],
	[
		"double-escaped slashes",
		String.raw`https:\\\/\\\/alice:hunter2@host`,
		String.raw`https:\\\/\\\/[redacted]@host`,
	],
	[
		"escaped colon with a backslash run",
		String.raw`https\\u003a//alice:hunter2@host`,
		String.raw`https\\u003a//[redacted]@host`,
	],
	[
		"JSON-escaped slashes and a separator in the password",
		String.raw`https:\/\/alice:pa:\/\/ss@host`,
		String.raw`https:\/\/[redacted]@host`,
	],
	[
		"Unicode escapes and a separator in the password",
		String.raw`https\u003a\u002f\u002falice:pa\u003a\u002f\u002fss\u0040host`,
		String.raw`https\u003a\u002f\u002f[redacted]\u0040host`,
	],
	[
		"HTML entities and a separator in the password",
		"https&#58;&#47;&#47;alice:pa&#58;&#47;&#47;ss&#64;host",
		"https&#58;&#47;&#47;[redacted]&#64;host",
	],
	[
		"percent-encoding at depth",
		"https%253A%252F%252Falice%253Ahunter2%2540host",
		"https%253A%252F%252F[redacted]%2540host",
	],
	[
		"double-escaped hex",
		String.raw`https\\x3a\\x2f\\x2falice:hunter2\\x40host`,
		String.raw`https\\x3a\\x2f\\x2f[redacted]\\x40host`,
	],
	[
		"double-escaped octal",
		String.raw`https\\072\\057\\057alice:hunter2\\100host`,
		String.raw`https\\072\\057\\057[redacted]\\100host`,
	],
	[
		"code-point escapes",
		String.raw`https\u{3a}\u{2f}\u{2f}alice:hunter2\u{0040}host`,
		String.raw`https\u{3a}\u{2f}\u{2f}[redacted]\u{0040}host`,
	],
	[
		"entities without semicolons",
		"https&#58&#47&#x2fuser:hunter2&#64host",
		"https&#58&#47&#x2f[redacted]&#64host",
	],
	[
		"line breaks and backslashes",
		"https:\t\\\r\n/alice:hunter2@host",
		"https:\t\\\r\n/[redacted]@host",
	],
])("masks URL credentials written with %s", (_name, input, expected) => {
	expect(textOutput(input)).toBe(expected);
});

it("masks the value of every proxy setting, as of a credential name", () => {
	expect(JSON.parse(argsText({ http_proxy: "alice:pw@host", NO_PROXY: "x", proxy: "y" }))).toEqual({
		http_proxy: "[redacted]",
		NO_PROXY: "[redacted]",
		proxy: "[redacted]",
	});
	expect(textOutput("ALL_PROXY=alice:pw@host\nstatus=ready")).toBe(
		"ALL_PROXY=[redacted]\nstatus=ready",
	);
});

it("masks a Slack token", () => {
	let token = ["xox", "p-123456789012-123456789012-abcdef0123456789"].join("");
	expect(textOutput(`token ${token} done`)).toBe("token [redacted] done");
});

it.each([
	"Contact alice@example.com or user@host for access.",
	"git remote add origin git@github.com:octo-org/score.git",
	"Lunch is at 12:30@noon.",
	"ssh://git@github.com/octo-org/score.git",
	"https://alice@example.com/x",
	"ssh://git@[::1]:22/repo",
	"https://example.com/x and https://example.org/y",
	"https://ghp_short.example.com/x",
	"https://@host/x",
	"https://host/a//b",
	"file:///x",
	"see https://host/a//b and file:///x",
])("retains text without URL credentials exactly: %s", output => {
	expect(outputText(output)).toBe(output);
	expect(textOutput(output)).toBe(output);
});

it.each([
	["many schemes", `${"a://u:p/".repeat(12_499)}@host`],
	["many at signs", `https://alice:${"@".repeat(100_000)}`],
	["colon and at runs", `https://${":@".repeat(50_000)}`],
	["unterminated userinfo", `https://alice:${"x/".repeat(50_000)}`],
	["escaped schemes", `${String.raw`a:\/\/u:p\/`.repeat(8_999)}@host`],
	["schemes without at-signs before the last", `${"https://example.com ".repeat(5_000)}@`],
	["schemes each with an at-sign", "https://u:p@h ".repeat(7_000)],
	["escaped at-signs", `https://${String.raw`\u0040`.repeat(16_000)}`],
	["backslash runs", `https:${"\\".repeat(100_000)}@`],
	["schemes after backslash runs", `${"a:\\\\\\\\\\\\\\\\".repeat(10_000)}@`],
	["entity runs", `https://${"&#00000".repeat(14_000)}`],
	["percent-encoded schemes", `${"a%3A%2F%2Fu%3Ap".repeat(6_000)}%40host`],
	["a long window per scheme", `${`https://${"x".repeat(9_000)} `.repeat(11)}@`],
	["many separators before one at-sign", `${"a://".repeat(25_000)}@host`],
	["percent-encoded escape runs", `https://alice:%${"25".repeat(50_000)}`],
	["repeated percent-encoded escapes", `https://${"%25".repeat(33_000)}40`],
	["deeply percent-encoded schemes", `${"a%253A%252F%252Fu%253Ap".repeat(4_000)}%2540host`],
	["hex escape runs", `https://${String.raw`\x`.repeat(50_000)}40`],
	["hex-escaped schemes", String.raw`a\x3a\x2f\x2fu:p`.repeat(6_000) + String.raw`\x40host`],
	["code-point escape runs", `https://${String.raw`\u{0`.repeat(25_000)}`],
	["octal escape runs", `https:${String.raw`\0`.repeat(50_000)}`],
	["line-break runs after colons", `${":\t\r\n".repeat(25_000)}//@`],
	["backslash separators", `${String.raw`a:\\u:p`.repeat(14_000)}@host`],
	["protocol-relative runs", `${" //u:p".repeat(16_666)}@host`],
	["slash runs", `${"/".repeat(100_000)}@`],
	["quoted slash runs", `${'"//'.repeat(33_333)}@`],
])("masks URL credentials promptly in 100KB of %s", (_name, output) => {
	let start = performance.now();
	outputText(output);
	textOutput(output);
	argsText({ output });
	argsText({ [output]: true });
	expect(performance.now() - start).toBeLessThan(500);
});
