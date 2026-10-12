/**
 * Exact reproductions from the adversarial reviews of #489, each with the parts of its
 * credential that no redacted view may show.
 */
export const URL_CREDENTIAL_LEAKS: Array<[name: string, input: string, secrets: string[]]> = [
	["space in user name", "https://alice smith:hunter2@host/x", ["alice", "smith", "hunter2"]],
	["space in password", "https://alice:hunter 2@host/x", ["alice", "hunter"]],
	["tab in password", "https://alice:hun\tter2@host/x", ["alice", "hun", "ter2"]],
	["newline in password", "https://alice:hun\nter2@host/x", ["alice", "hun", "ter2"]],
	["CRLF in password", "https://alice:hun\r\nter2@host/x", ["alice", "hun", "ter2"]],
	["NBSP in password", "https://alice:hun\u00a0ter2@host/x", ["alice", "hun", "ter2"]],
	["FEFF in password", "https://alice:hun\ufeffter2@host/x", ["alice", "hun", "ter2"]],
	["quote in password", 'https://alice:hun"ter2@host/x', ["alice", "hun", "ter2"]],
	["angle bracket in password", "https://alice:hun<ter2@host/x", ["alice", "hun", "ter2"]],
	["backtick in password", "https://alice:hun`ter2@host/x", ["alice", "hun", "ter2"]],
	["quote in a Markdown link", '[repo](https://alice:hun"ter2@host/x)', ["alice", "hun", "ter2"]],
	["tab in user name", "https://al\tice:hunter2@host/x", ["ice", "hunter2"]],
	[
		"JSON-escaped slashes",
		String.raw`{"url":"https:\u002f\u002falice:hunter2@host/x"}`,
		["alice", "hunter2"],
	],
	["JSON-escaped at-sign", String.raw`{"url":"https://alice:hunter2\u0040host/x"}`, [
		"alice",
		"hunter2",
	]],
	["JSON-escaped scheme colon", String.raw`{"url":"https\u003a//alice:hunter2@host/x"}`, [
		"alice",
		"hunter2",
	]],
	["JSON-escaped password colon", String.raw`{"url":"https://alice\u003ahunter2@host/x"}`, [
		"alice",
		"hunter2",
	]],
	["mixed slash escapes", String.raw`{"url":"https:\/\u002falice:hunter2@host/x"}`, [
		"alice",
		"hunter2",
	]],
	["first slash escaped", String.raw`{"url":"https:\//alice:hunter2@host/x"}`, [
		"alice",
		"hunter2",
	]],
	["second slash escaped", String.raw`{"url":"https:/\/alice:hunter2@host/x"}`, [
		"alice",
		"hunter2",
	]],
	["HTML at-sign entity", "https://alice:hunter2&#64;host/x", ["alice", "hunter2"]],
	["full percent-encoding", "https%3A%2F%2Falice%3Ahunter2%40host%2Fx", ["alice", "hunter2"]],
	[
		"Unicode-escaped URL as a JSON key",
		String.raw`{"https:\u002f\u002falice:hunter2@host/x":true}`,
		["alice", "hunter2"],
	],
	[
		"nested JSON.stringify",
		JSON.stringify(JSON.stringify(String.raw`{"url":"https:\/\/alice:hunter2@host\/x"}`)),
		["alice", "hunter2"],
	],
	["ya29. user name", "https://ya29.a0AfH6SMBsynthetic1234567890@host/x", ["a0AfH6SMBsynthetic"]],
	[
		"partly percent-encoded ghp_ user name",
		"https://%67hp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456@github.com/o/r",
		["ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"],
	],
	[
		"fully percent-encoded ghp_ user name",
		"https://%67%68%70%5FABCDEFGHIJKLMNOPQRSTUVWXYZ123456@host/x",
		["ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"],
	],
	["backslash in postgres user name", "postgres://al\\ice:hunter2@host/x", ["ice", "hunter2"]],
	["backslash in postgres password", "postgres://alice:123\\secret@host/x", ["alice", "secret"]],
	["numeric password prefix and query", "https://alice:12?secret@host/x", ["alice", "secret"]],
	[
		"256-character password after a backslash",
		`postgres://alice:p\\${"x".repeat(256)}@host/x`,
		["alice", "x".repeat(16)],
	],
	["256-character password after a slash", `https://alice:p/${"x".repeat(256)}@host/x`, [
		"alice",
		"x".repeat(16),
	]],
	[
		"shortened password revealing a Slack token",
		`https://alice:${"p".repeat(4100)}@host.example/path `
		+ ["xox", "b-123456789012-123456789012-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join(""),
		["alice", "p".repeat(16), "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
	],
	["doubly percent-encoded at-sign", "https://alice:hunter2%2540host/x", ["alice", "hunter2"]],
	["triply percent-encoded at-sign", "https://alice:hunter2%252540host/x", ["alice", "hunter2"]],
	["doubly percent-encoded URL", "https%253A%252F%252Falice%253Ahunter2%2540host", [
		"alice",
		"hunter2",
	]],
	["hex-escaped at-sign", String.raw`https://alice:hunter2\x40host/x`, ["alice", "hunter2"]],
	["hex-escaped slashes", String.raw`https:\x2f\x2falice:hunter2@host/x`, ["alice", "hunter2"]],
	["hex escapes in upper case", String.raw`https\X3A\X2F\X2Falice:hunter2\X40host/x`, [
		"alice",
		"hunter2",
	]],
	["double-escaped hex", String.raw`https\\x3a\\x2f\\x2falice:hunter2\\x40host/x`, [
		"alice",
		"hunter2",
	]],
	["entity inside the scheme", "http&#115;://alice:hunter2@host/x", ["alice", "hunter2"]],
	["decimal at-sign entity without a semicolon", "https://alice:hunter2&#64host/x", [
		"alice",
		"hunter2",
	]],
	["hex at-sign entity without a semicolon", "https://alice:hunter2&#x40host/x", [
		"alice",
		"hunter2",
	]],
	["separator entities without semicolons", "https&#58&#47&#47alice:hunter2@host/x", [
		"alice",
		"hunter2",
	]],
	["hex separator entities without semicolons", "https&#x3a&#x2f&#x2fuser:hunter2@host/x", [
		"user",
		"hunter2",
	]],
	["at-sign entity with leading zeros", "https://alice:hunter2&#064;host/x", ["alice", "hunter2"]],
	["code-point escaped at-sign", String.raw`https://alice:hunter2\u{40}host/x`, [
		"alice",
		"hunter2",
	]],
	["code-point escaped separator", String.raw`https\u{3a}\u{2f}\u{002F}alice:hunter2@host/x`, [
		"alice",
		"hunter2",
	]],
	["octal-escaped at-sign", String.raw`https://alice:hunter2\100host/x`, ["alice", "hunter2"]],
	["octal-escaped separator", String.raw`https\072\057\057alice:hunter2@host/x`, [
		"alice",
		"hunter2",
	]],
	["double-escaped octal", String.raw`https:\\057\\057alice:hunter2\\100host/x`, [
		"alice",
		"hunter2",
	]],
	["tab before the slashes", "https:\t//alice:hunter2@host/x", ["alice", "hunter2"]],
	["newline between the slashes", "https:/\n/alice:hunter2@host/x", ["alice", "hunter2"]],
	["backslashes for slashes", String.raw`https:\\alice:hunter2@host/x`, ["alice", "hunter2"]],
	["a backslash and a slash", String.raw`https:\/alice:hunter2@host/x`, ["alice", "hunter2"]],
	["protocol-relative URL", "//alice:pw@host/x", ["alice", "pw"]],
	["protocol-relative URL after a space", "clone //alice:pw@host/x", ["alice", "pw"]],
	["protocol-relative URL in a JSON string", String.raw`{"url":"\/\/alice:pw@host\/x"}`, [
		"alice",
		"pw",
	]],
	["Python-escaped at-sign", String.raw`https://alice:pw\U00000040host/x`, ["alice", "pw"]],
	["double-escaped Python at-sign", String.raw`https://alice:pw\\U00000040host/x`, [
		"alice",
		"pw",
	]],
	[
		"Python-escaped separator",
		String.raw`https\U0000003a\U0000002f\U0000002Falice:pw@host/x`,
		["alice", "pw"],
	],
	["JavaScript %u-escaped at-sign", "https://alice:pw%u0040host/x", ["alice", "pw"]],
	["JavaScript %u-escaped separator", "https%U003A%u002f%u002Falice%u003apw@host/x", [
		"alice",
		"pw",
	]],
	["lower-case proxy assignment", "http_proxy=alice:pw@host", ["alice", "pw"]],
	["upper-case proxy assignment holding a URL", "HTTPS_PROXY=https://alice:pw@host", [
		"alice",
		"pw",
	]],
];
