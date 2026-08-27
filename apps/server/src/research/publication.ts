import * as Plan from "../plan/service";
import { StorageError } from "../storage/errors";

import type { ResearchEvidence, ResearchReport } from "../jobs/research-workspace";
import type { Lease, ResearchWorkspace } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

const MARKDOWN_PUNCTUATION = new Set(`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`);

function reportText(value: string): string {
	return [...value.trim().replace(/\s+/g, " ")]
		.map(point => MARKDOWN_PUNCTUATION.has(point) ? `\\${point}` : point)
		.join("");
}

function reportLink(label: string, url: string): string {
	return `[${reportText(label)}](<${url}>)`;
}

export function researchReportSource(
	report: ResearchReport,
	sources: ResearchEvidence["sources"],
): string {
	let blocks = [`# ${reportText(report.title)}`, reportText(report.summary)];
	if (report.findings.length > 0) {
		blocks.push("## Findings");
		for (let finding of report.findings) {
			let sourceText = finding.sourceUrls.length > 0
				? ` Sources: ${
					finding.sourceUrls.map((url, index) => reportLink(String(index + 1), url)).join(
						", ",
					)
				}`
				: "";
			blocks.push(`- ${reportText(finding.text)}${sourceText}`);
		}
	}
	if (report.caveats.length > 0) {
		blocks.push("## Caveats");
		for (let caveat of report.caveats) blocks.push(`- ${reportText(caveat)}`);
	}
	if (sources.length > 0) {
		blocks.push("## Sources");
		for (let source of sources) blocks.push(`- ${reportLink(source.title, source.url)}`);
	}
	return `${blocks.join("\n\n")}\n`;
}

export async function publishInitialResearchChild(input: {
	storage: StorageAdapter;
	workspace: ResearchWorkspace;
	answerJobId: string;
	title: string;
	report: ResearchReport;
	sources: ResearchEvidence["sources"];
	now: Date;
	lease: Lease;
	changed: (workspace: ResearchWorkspace) => void | Promise<void>;
}): Promise<"published" | "pending"> {
	let initial = await Plan.initial(researchReportSource(input.report, input.sources));
	let published;
	try {
		published = await input.storage.research.publishInitialReport({
			channelId: input.workspace.channelId,
			workspaceId: input.workspace.id,
			answerJobId: input.answerJobId,
			title: input.title,
			initial,
			now: input.now,
			lease: input.lease,
		});
	} catch (err) {
		if (err instanceof StorageError && err.failure === "unavailable") return "pending";
		throw err;
	}
	if (!published.repeated) await input.changed(published.workspace);
	return "published";
}
