import { CheckIcon } from "@chopin/icons";

import { ExcerptCorrection } from "./excerpt-correction";
import { answerText, questionName, SIGNALS } from "./analysis-labels";

import type { ConversationPlan } from "@chopin/protocol";
import type { CardLink } from "./links";
import type { ExcerptCorrectionAction } from "./analysis-action";

export type { ExcerptCorrectionAction } from "./analysis-action";

export function AnalysisOverview({
	analysis,
	canEdit = false,
	links,
	messageId = "",
	messageText,
	onAddExcerpt,
	state,
	status,
}: {
	analysis?: ConversationPlan.AnalysisRecord;
	canEdit?: boolean;
	links: CardLink[];
	messageId?: string;
	messageText: string;
	onAddExcerpt?: (action: ExcerptCorrectionAction) => Promise<void>;
	state?: ConversationPlan.State;
	status: ConversationPlan.AnalysisRecord["status"];
}) {
	let outcomes = analysis?.outcomes ?? [];
	let applied = outcomes.filter(outcome => outcome.status === "accepted").length;
	let targetIds = [...new Set(outcomes.map(outcome => outcome.targetId).filter(Boolean))];
	if (targetIds.length === 0) targetIds = [...new Set(links.map(link => link.threadId))];
	let target = targetIds.length === 1
		? state?.threads.find(thread => thread.id === targetIds[0])?.question
		: targetIds.length > 1
		? `${targetIds.length} decisions`
		: undefined;
	let heading = status === "applied"
		? outcomes.length ? `${applied} finding${applied === 1 ? "" : "s"} applied` : "Plan updated"
		: status === "unlinked"
		? "No plan change"
		: status === "failed"
		? "Analysis failed"
		: status === "running"
		? "Jev is analysing"
		: "Waiting for analysis";
	let triage = analysis?.passes.find(pass => pass.stage === "triage");
	let signals = Object.entries(triage?.answers ?? {})
		.filter(([key, answer]) => SIGNALS[key] && answer.type === "noul" && answer.noul >= 0.55)
		.sort((a, b) => (b[1] as { noul: number }).noul - (a[1] as { noul: number }).noul)
		.map(([key]) => SIGNALS[key]);
	let rows = outcomes.map((outcome, index) => {
		let completeLink = links.find(item =>
			item.source.start === outcome.start && item.source.end === outcome.end
		);
		let linkedSubspans = links.filter(item =>
			item.source.start >= outcome.start && item.source.end <= outcome.end
			&& (item.source.start !== outcome.start || item.source.end !== outcome.end)
		).map(item => item.source);
		let link = completeLink
			?? links.find(item => item.source.start >= outcome.start && item.source.end <= outcome.end);
		let role = analysis?.passes.find(pass => pass.stage === "targeting")?.answers[
			`c${index}_role`
		];
		let label = link?.label ?? (role?.type === "choice"
			? role.choice.replaceAll("_", " ")
			: "Excerpt");
		let quote = messageText.slice(outcome.start, outcome.end);
		return {
			outcome,
			label,
			link,
			completeLink: !!completeLink,
			linkedSubspans,
			quote: quote || link?.source.quote || `Excerpt ${index + 1}`,
		};
	});
	if (rows.length === 0 && links.length > 0) {
		rows = links.map(link => ({
			outcome: {
				start: link.source.start,
				end: link.source.end,
				status: "accepted" as const,
				gate: "accepted",
				eventIds: [],
			},
			label: link.label,
			link,
			completeLink: true,
			linkedSubspans: [],
			quote: link.source.quote,
		}));
	}
	let review = rows.filter(row => row.outcome.status === "review" && !row.completeLink).length;
	let ignored = rows.filter(row => row.outcome.status === "ignored" && !row.completeLink).length;

	return (
		<>
			<div className="flex items-center gap-2">
				<span
					aria-hidden="true"
					className={`size-2 shrink-0 rounded-full ${
						status === "failed" ? "bg-destructive" : status === "applied"
							? "bg-success"
							: "bg-neutral-graphic"
					}`}
				/>
				<strong className="text-sm text-text-primary">{heading}</strong>
			</div>
			<p className="m-0 mt-2 text-sm leading-5">
				{status === "applied"
					? (
						<>
							Chopin linked this message{target
								? (
									<>
										to <b>{target}</b>
									</>
								)
								: ""}.
						</>
					)
					: status === "unlinked"
					? "Chopin did not apply a card change from this message."
					: status === "failed"
					? analysis?.error || "Jev could not complete this analysis."
					: "The message has not finished processing yet."}
			</p>
			{signals.length > 0 && (
				<div className="mt-3">
					<p className="m-0 mb-1 text-sm font-medium text-text-tertiary">Jev detected</p>
					<div className="flex flex-wrap gap-1">
						{signals.map(signal => (
							<span
								className="rounded-full bg-inset px-2 py-0.5 text-sm text-text-secondary"
								key={signal}
							>
								{signal}
							</span>
						))}
					</div>
				</div>
			)}
			{rows.length > 0 && (
				<div className="mt-3 hairline-t" aria-label="How excerpts were handled">
					{rows.map(({ outcome, label, link, completeLink, linkedSubspans, quote }, index) => (
						<div
							className="flex gap-2 hairline-b py-2 last:border-b-0"
							key={`${outcome.start}-${outcome.end}-${index}`}
						>
							<span
								aria-hidden="true"
								className={`w-4 shrink-0 ${
									outcome.status === "accepted" ? "text-success-ink" : "text-text-tertiary"
								}`}
							>
								{outcome.status === "accepted" ? <CheckIcon aria-hidden="true" size={14} /> : "·"}
							</span>
							<div className="min-w-0 flex-1">
								<div className="flex items-baseline justify-between gap-2">
									<strong className="capitalize text-sm text-text-primary">{label}</strong>
									<span className="shrink-0 text-sm text-text-tertiary">
										{link && outcome.status !== "accepted"
											? "Added to card"
											: outcome.status === "accepted"
											? "Applied"
											: outcome.status === "review"
											? "Review"
											: "Not applied"}
									</span>
								</div>
								<p className="m-0 mt-0.5 break-words text-sm leading-4">“{quote}”</p>
								{outcome.status !== "accepted" && !link && (
									<p className="m-0 mt-1 text-sm text-text-tertiary">{outcome.gate}</p>
								)}
								{["review", "ignored"].includes(outcome.status) && (
									<ExcerptCorrection
										canEdit={canEdit}
										linked={completeLink}
										linkedSubspans={linkedSubspans}
										messageId={messageId}
										messageText={messageText}
										onAddExcerpt={onAddExcerpt}
										outcome={outcome}
										quote={quote}
										state={state}
									/>
								)}
							</div>
						</div>
					))}
				</div>
			)}
			{outcomes.length > 0 && (review > 0 || ignored > 0) && (
				<p className="m-0 mt-1 text-sm text-text-tertiary">
					{review} held for review · {ignored} not applied
				</p>
			)}
			{analysis && (
				<details className="mt-3 hairline-t pt-2">
					<summary className="cursor-pointer text-sm font-medium text-brand-ink">
						Model answers and run details
					</summary>
					<div className="mt-2 text-sm leading-4 text-text-tertiary">
						<p className="m-0">
							Model {analysis.modelVersion || "not recorded"} · Questions{" "}
							{analysis.questionSetVersion || "not recorded"}
							{analysis.latencyMs === undefined ? "" : ` · ${analysis.latencyMs} ms`}
						</p>
						{analysis.policyGate && <p className="m-0 mt-1">Policy: {analysis.policyGate}</p>}
						{analysis.quoteValidation && (
							<p className="m-0 mt-1">
								Source quotes:{" "}
								{analysis.quoteValidation.filter(range => range.valid).length}/{analysis
									.quoteValidation.length} valid
							</p>
						)}
						{analysis.passes.map((pass, index) => (
							<section className="mt-2 hairline-t pt-2" key={`${pass.stage}-${index}`}>
								<h4 className="m-0 capitalize text-sm text-text-primary">{pass.stage}</h4>
								<dl className="m-0 mt-1">
									{Object.entries(pass.answers).map(([key, answer]) => (
										<div className="flex justify-between gap-2 py-0.5" key={key}>
											<dt className="min-w-0 break-words">{questionName(key)}</dt>
											<dd className="m-0 shrink-0 text-right text-text-secondary">
												{answerText(answer)}
											</dd>
										</div>
									))}
								</dl>
							</section>
						))}
					</div>
				</details>
			)}
		</>
	);
}
