import { validateVerification } from "./state.mjs";
import { openState, sealState } from "./state-store.mjs";

let marker = "<!-- chopin:pr-maintenance:v1 -->";
let ownedLabels = ["maintenance:working", "maintenance:ready", "needs-human-attention"];
function authenticated(comment, repository, number, key) {
	if (comment.user?.login !== "github-actions[bot]" || comment.user?.type !== "Bot") return null;
	let match = comment.body?.match(/\n<!-- chopin:pr-maintenance-auth:([A-Za-z0-9+/=]+) -->$/);
	if (!match || !comment.body.startsWith(marker)) return null;
	try {
		let envelope = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
		let payload = openState(envelope, repository, key);
		let record = payload.prs[String(number)];
		if (
			payload.revision !== 0 || Object.keys(payload.prs).length !== 1
			|| record?.body !== comment.body.slice(0, match.index)
		) return null;
		return record;
	} catch {
		return null;
	}
}
function safe(value) {
	return String(value).replaceAll("@", "＠");
}

function summary(value) {
	return safe(value).slice(0, 500).replace(/[\r\n]/g, " ")
		.replace(/[&<>`*_[\]\\]/g, (character) => `&#${character.charCodeAt(0)};`);
}

export async function reportMaintenance(
	{ repository, state, request, key, pr, runUrl, ciUrl = null },
) {
	let prefix = `/repos/${repository}`;
	let issue = `${prefix}/issues/${state.number}`;
	let current = new Set(pr.labels.map((label) => typeof label === "string" ? label : label.name));
	let target = state.status === "opted-out" ? null : state.status === "blocked"
		? "needs-human-attention"
		: state.status === "ready"
		? "maintenance:ready"
		: "maintenance:working";
	for (let name of ownedLabels) {
		if (current.has(name) && name !== target) {
			await request("DELETE", `${issue}/labels/${encodeURIComponent(name)}`);
		}
	}
	if (target && !current.has(target)) {
		try {
			await request("GET", `${prefix}/labels/${encodeURIComponent(target)}`);
		} catch (error) {
			if (error.status !== 404) throw error;
			await request("POST", `${prefix}/labels`, {
				name: target,
				color: target === "needs-human-attention" ? "d4a72c" : "0969da",
			});
		}
		await request("POST", `${issue}/labels`, { labels: [target] });
	}
	if (!target) return;
	let existing = null;
	for (let page = 1;; page++) {
		let comments = await request("GET", `${issue}/comments?per_page=100&page=${page}`);
		for (let comment of comments) {
			let record = authenticated(comment, repository, state.number, key);
			if (record) existing = { comment, record };
		}
		if (comments.length < 100) break;
	}
	let blockerId = state.blocker?.id ?? null;
	if (
		state.status === "blocked" && state.blocker.kind === "human"
		&& existing?.record.blockerId === blockerId
	) return;
	let body = `${marker}\n**PR maintenance: ${
		state.status === "ready" ? "ready" : state.status === "blocked" ? "needs attention" : "working"
	}**`;
	if (state.status === "blocked") {
		body += `\n\n${safe(state.blocker.reason)}`;
		if (state.blocker.kind === "infrastructure") {
			body += "\n\nInspect the shared coordinator Actions run for infrastructure diagnosis.";
		} else {
			body +=
				"\n\nNeeded decision: resolve the blocker above or request another maintenance attempt.";
			let owners = pr.assignees.filter((user) => user.type === "User");
			if (!owners.length && pr.user?.type === "User") owners = [pr.user];
			let notification = owners.filter((user) => /^[A-Za-z0-9-]+$/.test(user.login)).map((user) =>
				`@${user.login}`
			).join(" ");
			if (existing?.record.blockerId === blockerId) {
				// Keep the signed notification text stable; edits never introduce another ping.
				notification = existing.record.body.match(/\n\nOwner: ([^\n]*)/)?.[1] ?? "";
			}
			body += notification
				? `\n\nOwner: ${notification}`
				: "\n\nAssign a human owner to make this decision.";
		}
	} else if (state.status !== "ready") {
		body += `\n\n${
			safe(
				state.status === "working"
					? state.active?.action ?? state.action ?? "verification"
					: state.status,
			)
		} in progress.`;
	}
	body += `\n\nInspected head: ${summary(state.head)}\n\nBase head: ${summary(state.baseHead)}`;
	if (state.verification) {
		validateVerification(state.verification);
		body += `\n\nLast applied commit: ${summary(state.verification.head)}`;
		if (state.verification.head === state.head) {
			let evidence = "";
			let entries = [`\n\nChanges (${state.verification.operation}):`];
			entries.push(...state.verification.paths.slice(0, 20).map((path) => `\n- ${summary(path)}`));
			entries.push("\n\nAgent-reported checks (CI readiness is verified separately):");
			entries.push(
				...state.verification.checks.slice(0, 10).map((check) =>
					`\n- ${summary(check.command)}: ${summary(check.result)}`
				),
			);
			entries.push(
				...state.verification.hashReviews.slice(0, 5).map((review) =>
					`\n\nHash renewal review for ${summary(review.file)} (${review.sourceHash}): ${
						summary(review.rationale)
					}`
				),
			);
			let omitted = state.verification.paths.length > 20 || state.verification.checks.length > 10
				|| state.verification.hashReviews.length > 5;
			for (let entry of entries) {
				if (Buffer.byteLength(evidence + entry) > 8 * 1024) {
					omitted = true;
					break;
				}
				evidence += entry;
			}
			body += evidence;
			if (omitted) body += "\n\nMore details in the coordinator run.";
		}
	}
	body += `\n\n[Coordinator run](${runUrl})${ciUrl ? ` · [CI run](${ciUrl})` : ""}`;
	if (Buffer.byteLength(body) > 20 * 1024) {
		throw new Error("Maintenance comment exceeds body budget");
	}
	if (existing?.record.body === body && existing.record.blockerId === blockerId) return;
	let packet = sealState({
		schemaVersion: 1,
		repository,
		revision: 0,
		prs: { [state.number]: { body, blockerId } },
	}, key);
	let rendered = `${body}\n<!-- chopin:pr-maintenance-auth:${
		Buffer.from(JSON.stringify(packet)).toString("base64")
	} -->`;
	if (Buffer.byteLength(rendered) >= 65_000) {
		throw new Error("Maintenance comment exceeds GitHub limit");
	}
	await request(
		existing ? "PATCH" : "POST",
		existing ? `${prefix}/issues/comments/${existing.comment.id}` : `${issue}/comments`,
		{ body: rendered },
	);
}
