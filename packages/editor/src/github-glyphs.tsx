import {
	IssueCompletedIcon,
	IssueNotPlannedIcon,
	IssueOpenIcon,
	PendingIcon,
	PrivateIcon,
	PullRequestClosedIcon,
	PullRequestDraftIcon,
	PullRequestMergedIcon,
	PullRequestOpenIcon,
} from "@chopin/icons";

import type { GitHubReferenceKind } from "@chopin/protocol/github-reference";
import type { GitHubPillState } from "./github-references";

const GLYPHS = {
	"pr-open": PullRequestOpenIcon,
	"pr-merged": PullRequestMergedIcon,
	"pr-closed": PullRequestClosedIcon,
	"pr-draft": PullRequestDraftIcon,
	"issue-open": IssueOpenIcon,
	"issue-completed": IssueCompletedIcon,
	"issue-not-planned": IssueNotPlannedIcon,
	loading: PendingIcon,
	unavailable: PrivateIcon,
} as const;

export type GlyphName = keyof typeof GLYPHS;

export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[];

/** The glyph a state draws; an unknown status keeps its kind's open glyph, in neutral. */
export function glyphName(state: GitHubPillState, kind: GitHubReferenceKind): GlyphName {
	if (state !== "unknown") return state;
	return kind === "pull" ? "pr-open" : "issue-open";
}

export function GitHubGlyph({ name }: { name: GlyphName }) {
	let Glyph = GLYPHS[name];
	return <Glyph />;
}
