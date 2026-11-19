import { useCallback, useEffect, useId, useState } from "react";
import { RestartIcon } from "@chopin/icons";
import { AI_USAGE_DAYS } from "@chopin/protocol/ai-usage";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@chopin/visuals";
import { InlineNotice } from "@chopin/visuals/inline-notice";

import type { AiProvider } from "@chopin/protocol/ai-credentials";
import type { AiModelUsage, AiUsageSummary } from "@chopin/protocol/ai-usage";

const PROVIDER_NAMES: Record<AiProvider, string> = {
	"github-copilot": "GitHub Copilot",
	openai: "OpenAI",
	anthropic: "Anthropic",
};

const wholeNumber = new Intl.NumberFormat("en");
const tokenCount = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** What the section shows: the totals once they have come, or that they couldn't be read. */
export type UsageByModelState =
	| { phase: "loading" }
	| { phase: "loaded"; usage: AiUsageSummary }
	| { phase: "failed" };

function tokens(value: number): string {
	return tokenCount.format(value);
}

function rowKey(model: AiModelUsage): string {
	return `${model.provider}\n${model.model ?? ""}`;
}

function ModelRow({ model }: { model: AiModelUsage }) {
	return (
		<TableRow>
			<TableCell>
				<span className="flex min-w-0 flex-col">
					<span className="truncate font-medium" title={model.model}>
						{model.model ?? "Other requests"}
					</span>
					<span className="text-xs text-text-tertiary">{PROVIDER_NAMES[model.provider]}</span>
				</span>
			</TableCell>
			<TableCell className="text-right tabular-nums">
				{wholeNumber.format(model.requests)}
			</TableCell>
			<TableCell className="text-right tabular-nums">
				<span className="flex flex-col items-end">
					<span>{wholeNumber.format(model.errors)}</span>
					{model.unknown > 0 && (
						<span className="text-xs text-text-tertiary">
							{wholeNumber.format(model.unknown)} unknown
						</span>
					)}
				</span>
			</TableCell>
			<TableCell className="text-right tabular-nums">{tokens(model.tokens.input)}</TableCell>
			<TableCell className="text-right tabular-nums">{tokens(model.tokens.output)}</TableCell>
			<TableCell className="text-right tabular-nums">{tokens(model.tokens.cacheRead)}</TableCell>
			<TableCell className="text-right tabular-nums">{tokens(model.tokens.cacheWrite)}</TableCell>
		</TableRow>
	);
}

/**
 * The person's own AI requests over the last week, by model: how many their launches sent, how
 * many ended in an error, and the tokens the providers reported.
 */
export function UsageByModelSection(
	{ state, onRetry }: { state: UsageByModelState; onRetry: () => void },
) {
	let headingId = useId();
	let lead =
		`Requests your launches sent in the last ${AI_USAGE_DAYS} days, and the tokens they used.`;
	return (
		<section
			aria-busy={state.phase === "loading" || undefined}
			aria-labelledby={headingId}
			className="flex flex-col gap-3"
		>
			<h2 className="text-base font-semibold" id={headingId}>Usage by model</h2>
			<p className="text-sm text-text-secondary">{lead}</p>
			{state.phase === "loading" && (
				<p className="text-sm text-text-tertiary" role="status">Loading your usage…</p>
			)}
			{state.phase === "failed" && (
				<InlineNotice
					actions={
						<button className="btn btn-xs btn-outline" onClick={onRetry} type="button">
							<RestartIcon aria-hidden="true" />
							Retry
						</button>
					}
					message="Chopin couldn't load your usage."
				/>
			)}
			{state.phase === "loaded" && state.usage.models.length === 0 && (
				<p className="text-sm text-text-tertiary">
					No requests in the last {AI_USAGE_DAYS} days.
				</p>
			)}
			{state.phase === "loaded" && state.usage.models.length > 0 && (
				<Table aria-labelledby={headingId} variant="contained">
					<TableHeader>
						<TableRow>
							<TableHead>Model</TableHead>
							<TableHead className="text-right">Requests</TableHead>
							<TableHead className="text-right">Errors</TableHead>
							<TableHead className="text-right">Input</TableHead>
							<TableHead className="text-right">Output</TableHead>
							<TableHead className="text-right">Cache read</TableHead>
							<TableHead className="text-right">Cache write</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{state.usage.models.map(model => <ModelRow key={rowKey(model)} model={model} />)}
					</TableBody>
				</Table>
			)}
		</section>
	);
}

/** Reads the signed-in person's usage summary from `GET /api/ai/usage`. */
export async function loadUsage(signal?: AbortSignal): Promise<AiUsageSummary> {
	let response = await fetch("/api/ai/usage", { credentials: "same-origin", signal });
	if (!response.ok) throw new Error(`usage request failed with ${response.status}`);
	return (await response.json()) as AiUsageSummary;
}

/** The AI accounts page's Usage by model section, which loads the person's own totals. */
export function UsageByModel() {
	let [state, setState] = useState<UsageByModelState>({ phase: "loading" });
	let [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let abort = new AbortController();
		loadUsage(abort.signal).then(
			usage => setState({ phase: "loaded", usage }),
			() => {
				if (!abort.signal.aborted) setState({ phase: "failed" });
			},
		);
		return () => abort.abort();
	}, [attempt]);
	let retry = useCallback(() => {
		setState({ phase: "loading" });
		setAttempt(value => value + 1);
	}, []);
	return <UsageByModelSection onRetry={retry} state={state} />;
}
