import { expect, test } from "bun:test";
import { reportMaintenance } from "./presentation.mjs";
let key = "k".repeat(32);
function fixture() {
	let comments: any[] = [];
	let writes: any[] = [];
	let labels = [{ name: "custom" }];
	let request = async (method: string, path: string, body?: any) => {
		if (method === "GET") return path.includes("comments?") ? comments : {};
		writes.push({ method, path, body });
		if (path.endsWith("/comments") && method === "POST") {
			comments.push({
				id: 8,
				user: { login: "github-actions[bot]", type: "Bot" },
				body: body.body,
			});
		}
		return {};
	};
	return {
		repository: "o/r",
		state: {
			number: 3,
			status: "blocked",
			blocker: { id: "a", kind: "human", reason: "Ask @intruder for a choice" },
		},
		pr: {
			labels,
			assignees: [{ login: "owner", type: "User" }],
			user: { login: "robot", type: "Bot" },
		},
		runUrl: "https://example.test/run",
		key,
		request,
		comments,
		writes,
	};
}
test("authenticates one bot comment and sends owner mention once", async () => {
	let config = fixture();
	await reportMaintenance(config);
	expect(config.comments[0].body).toContain("@owner");
	expect(config.comments[0].body).not.toContain("@intruder");
	config.writes.length = 0;
	config.pr.labels.push({ name: "needs-human-attention" });
	await reportMaintenance(config);
	expect(config.writes).toHaveLength(0);
	config.comments[0].body += " edited";
	await reportMaintenance(config);
	expect(config.writes.some((item) => item.method === "POST" && item.path.endsWith("/comments")))
		.toBe(true);
});
test("infrastructure and opt-out never ping humans", async () => {
	let config = fixture();
	config.state.blocker.kind = "infrastructure";
	await reportMaintenance(config);
	expect(config.comments[0].body).not.toContain("@owner");
	config.state.status = "opted-out";
	config.writes.length = 0;
	await reportMaintenance(config);
	expect(config.writes).toHaveLength(0);
});
test("marker-only human comments stay untouched and unrelated labels survive", async () => {
	let config = fixture();
	config.comments.push({
		id: 2,
		user: { login: "owner", type: "User" },
		body: "<!-- chopin:pr-maintenance:v1 --> spoof",
	});
	config.pr.labels.push({ name: "maintenance:working" });
	await reportMaintenance(config);
	expect(config.writes.some((item) => item.method === "PATCH")).toBe(false);
	expect(config.writes.filter((item) => item.method === "DELETE").map((item) => item.path)).toEqual(
		["/repos/o/r/issues/3/labels/maintenance%3Aworking"],
	);
});
test("new blocker notifies again and bot-only ownership requests assignment", async () => {
	let config = fixture();
	config.pr.assignees = [];
	await reportMaintenance(config);
	expect(config.comments[0].body).toContain("Assign a human owner");
	config.state.blocker.id = "new";
	config.pr.assignees = [{ login: "owner", type: "User" }];
	await reportMaintenance(config);
	expect(config.writes.find((item) => item.method === "PATCH").body.body).toContain("@owner");
});
test("label permissions propagate rather than creating labels", async () => {
	let config = fixture();
	config.request = async () => {
		throw Object.assign(new Error("forbidden"), { status: 403 });
	};
	await expect(reportMaintenance(config)).rejects.toThrow("forbidden");
});

test("reports only matching-head verification with escaped untrusted text", async () => {
	let config = fixture();
	let head = "a".repeat(40);
	let state = {
		...config.state,
		status: "waiting-ci",
		head,
		baseHead: "b".repeat(40),
		blocker: null,
		verification: {
			head,
			operation: "fix",
			paths: ["apps/a.ts"],
			checks: [{ command: "bun test `@intruder`", result: "passed" }],
			hashReviews: [{
				file: "apps/a.ts",
				sourceHash: "c".repeat(64),
				rationale: "Reviewed @intruder `content`",
			}],
		},
	};
	await reportMaintenance({ ...config, state });
	let body = config.comments[0].body;
	expect(body).toContain(`Inspected head: ${head}`);
	expect(body).toContain("apps/a.ts");
	expect(body).toContain("Agent-reported checks");
	expect(body).not.toContain("@intruder");
	expect(body).not.toContain("`@intruder`");
	config.comments.length = 0;
	await reportMaintenance({ ...config, state: { ...state, head: "d".repeat(40) } });
	expect(config.comments[0].body).not.toContain("bun test");
});

test("escaped evidence remains within GitHub's comment limit including signed footer", async () => {
	let config = fixture();
	let head = "a".repeat(40);
	let state = {
		...config.state,
		head,
		baseHead: "b".repeat(40),
		status: "waiting-ci",
		blocker: null,
		verification: {
			head,
			operation: "fix",
			paths: ["apps/a.ts"],
			checks: Array.from(
				{ length: 10 },
				() => ({ command: "&".repeat(500), result: "&".repeat(500) }),
			),
			hashReviews: [],
		},
	};
	await reportMaintenance({ ...config, state });
	let body = config.comments[0].body;
	expect(Buffer.byteLength(body)).toBeLessThan(65_000);
	expect(body).toContain("More details in the coordinator run.");
	expect(body).toContain(`Inspected head: ${head}`);
	expect(body).toContain("[Coordinator run]");
});
