import { displayTitle, documentTitleText, limits, parse, withDocumentTitle } from "@chopin/dialect";
import { ExperimentError } from "@chopin/experiment";
import type { Result } from "@chopin/experiment";
import { canonical } from "../mcp/create";
import { reportText } from "../research/publication";

const SUMMARY_LENGTH = 240;
// Room for the ids canonicalization adds to each embed.
const SOURCE_BUDGET = limits.MAX_SOURCE_BYTES - 16 * 1024;
// Records own these; a submitted report may not mint their projections.
const PROTECTED = /"name":"(Questionnaire|Question|Decision|Research|Investigation|Experiment)"/;
const LANGUAGES = { plain: "", csv: "", json: "json", diff: "diff" } as const;

/** Markdown inline source as the words a reader sees. */
function plain(value: string): string {
	return value
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\\(.)|[*`~]/g, (_match, escaped?: string) => escaped ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function clip(value: string, length: number): string {
	let points = [...value];
	return points.length <= length ? value : `${points.slice(0, length - 1).join("").trimEnd()}…`;
}

/** A finished investigation's one-line result and opening paragraph, for a decision's findings. */
export function investigationFinding(
	brief: string,
	report: string,
): { title: string; summary?: string } {
	let { title, body } = split(brief, report);
	let paragraph = body.split(/\n{2,}/).map(block => block.trim()).find(block =>
		!!block && !/^(?:#|<|```|\||[-*] |\d+\. )/.test(block)
	);
	return { title, ...(paragraph ? { summary: plain(paragraph) } : {}) };
}

/** The report's own top heading leads the child; otherwise the brief names it. */
function split(brief: string, report: string): { title: string; lead: string; body: string } {
	let match = /^# (.+)\n+/.exec(report);
	let heading = match ? plain(match[1]) : "";
	if (match && heading) {
		return {
			title: displayTitle(heading),
			lead: withDocumentTitle(match[0], heading).trim(),
			body: report.slice(match[0].length),
		};
	}
	let title = displayTitle(
		plain(brief.split("\n").find(line => line.trim()) ?? "") || "Investigation",
	);
	return { title, lead: `# ${reportText(title)}`, body: report };
}

function fence(text: string, language: string): string {
	let longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(run => run[0].length));
	let marks = "`".repeat(Math.max(3, longest + 1));
	return `${marks}${language}\n${text.replace(/\n$/, "")}\n${marks}`;
}

/** One tight list; blank lines between items would make it loose and fail the round trip. */
function list(items: string[]): string {
	return items.map(item => `- ${reportText(item)}`).join("\n");
}

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** The first prose paragraph of a completed report, for the card that links to its child. */
export function investigationSummary(brief: string, result: Result): string {
	let { body } = split(brief, result.report);
	let paragraph = body.split(/\n{2,}/).find(block =>
		block.trim() && !/^\s*(#|[-*+] |\d+[.)] |>|```|~~~|<|\|)/.test(block)
	);
	return paragraph ? clip(plain(paragraph), SUMMARY_LENGTH) : "";
}

/**
 * A completed investigation as a research-shaped child document: its report, an embed for each
 * native view, then how the work was done. Raw evidence fills what room the source limit leaves.
 */
export function investigationDocument(
	id: string,
	brief: string,
	result: Result,
): { title: string; source: string } {
	if (PROTECTED.test(JSON.stringify(parse(result.report)))) {
		throw new ExperimentError(
			"protected-report",
			"A report cannot embed record-backed components.",
		);
	}
	let { title, lead, body } = split(brief, result.report);
	let blocks = [lead, body.trim()];
	if (result.views.length > 0) {
		blocks.push("## Views");
		for (let view of result.views) {
			blocks.push(`<Experiment experiment="${id}" view="${view.key}" />`);
		}
	}
	let { environment, checks, limitations } = result.provenance;
	if (environment.trim() || checks.length > 0) {
		blocks.push("## Method");
		if (environment.trim()) blocks.push(reportText(environment));
		if (checks.length > 0) blocks.push(list(checks));
	}
	if (limitations.length > 0) {
		blocks.push("## Limitations");
		blocks.push(list(limitations));
	}
	let used = bytes(blocks.join("\n\n"));
	let evidence: string[] = [];
	for (let item of result.evidence) {
		let heading = `### ${reportText(item.title)}`;
		let room = SOURCE_BUDGET - used - bytes(heading) - 64;
		if (room < 256) break;
		let text = bytes(item.text) <= room
			? item.text
			: `${Buffer.from(item.text).subarray(0, room).toString("utf8").replace(/�$/, "")}\n…`;
		let block = `${heading}\n\n${fence(text, LANGUAGES[item.format])}`;
		evidence.push(block);
		used += bytes(block) + 2;
	}
	if (evidence.length > 0) blocks.push("## Evidence", ...evidence);
	let source = canonical(`${blocks.filter(Boolean).join("\n\n")}\n`);
	if ("issues" in source) {
		throw new ExperimentError(
			"invalid-report",
			source.issues.map(issue => issue.message).join("; ").slice(0, 4000),
		);
	}
	return {
		title: displayTitle(documentTitleText(parse(source.source)) ?? title),
		source: source.source,
	};
}
