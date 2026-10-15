import {
	CircleCloseIcon,
	CodePullRequestIcon,
	DecisionIcon,
	GlobeSearchIcon,
	MagnifierIcon,
	PageIcon,
	PencilIcon,
	TerminalIcon,
	WarningIcon,
	WrenchIcon,
} from "@chopin/icons";

import { duration, toolKinds, workSummaryLabel, workTime } from "./model";
import { TraceLine, TraceTitle } from "../trace";

import "./work-summary.css";

import type { Chat } from "@chopin/protocol";
import type { ToolGlyph, ToolSummary } from "./model";

export const TOOL_ICONS: Record<ToolGlyph, typeof PageIcon> = {
	ask: DecisionIcon,
	other: WrenchIcon,
	page: PageIcon,
	"pull-request": CodePullRequestIcon,
	search: MagnifierIcon,
	terminal: TerminalIcon,
	web: GlobeSearchIcon,
	write: PencilIcon,
};

/** A finished turn's line: up to four tool-kind chips and how long they took, spoken as a sentence. */
export function WorkSummary(
	{ disconnected, summary, tools }: {
		disconnected: boolean;
		summary: ToolSummary;
		tools: Chat.Activity[];
	},
) {
	let time = workTime(tools);
	let title = disconnected ? "Connection lost" : time > 0 ? duration(time) : undefined;
	return (
		<TraceLine>
			<span className="sr-only">
				{workSummaryLabel(summary, disconnected, disconnected ? 0 : time)}
			</span>
			<span aria-hidden="true" className="work-summary">
				<span className="work-summary-pile">
					{toolKinds(tools).slice(0, 4).map(kind => {
						let Icon = TOOL_ICONS[kind.glyph];
						return (
							<span
								className="work-summary-chip"
								data-failed={kind.failed || undefined}
								key={kind.glyph}
							>
								<Icon size={12} />
							</span>
						);
					})}
				</span>
				{title && <TraceTitle enter>{title}</TraceTitle>}
				{!disconnected && summary.interrupted > 0 && (
					<span className="work-summary-stopped">
						<CircleCloseIcon size={14} />
					</span>
				)}
				{summary.failures > 0 && (
					<span className="work-summary-failed">
						<WarningIcon size={14} />
						{summary.failures}
					</span>
				)}
			</span>
		</TraceLine>
	);
}
