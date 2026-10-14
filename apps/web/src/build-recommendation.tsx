import { useId, useRef, useState } from "react";
import { LightbulbIcon, MessageIcon } from "@chopin/icons";
import { UnfoldSection } from "@chopin/visuals/unfold";

import { boundedChatError } from "./chat/references";

import "./build-recommendation.css";

import type { RefObject } from "react";
import type { ReadyRecommendation } from "./use-build-recommendation";

type Props = {
	snapshot: ReadyRecommendation;
	dismissed: boolean;
	disabled: boolean;
	onDiscuss: (snapshot: ReadyRecommendation) => Promise<void>;
	onDismiss: () => void;
	onRestore: () => void;
};

/** Dismissal belongs to this advice key and survives a refresh that briefly hides it. */
export function BuildRecommendation(
	{ snapshot, dismissed, disabled, onDiscuss, onDismiss, onRestore }: Props,
) {
	let restore = useRef<HTMLButtonElement>(null);
	let explore = useRef<HTMLButtonElement>(null);
	if (dismissed) {
		return (
			<div className="build-recommendation-restore">
				<button
					className="btn btn-sm btn-ghost"
					onClick={() => {
						onRestore();
						requestAnimationFrame(() => explore.current?.focus());
					}}
					ref={restore}
					type="button"
				>
					<LightbulbIcon aria-hidden="true" size={14} />
					Show suggested next step
				</button>
			</div>
		);
	}
	return (
		<RecommendationPanel
			disabled={disabled}
			explore={explore}
			key={snapshot.key}
			onDiscuss={onDiscuss}
			onExplore={() => {
				onDismiss();
				requestAnimationFrame(() => restore.current?.focus());
			}}
			snapshot={snapshot}
		/>
	);
}

function RecommendationPanel(
	{ snapshot, disabled, onDiscuss, onExplore, explore }:
		& Pick<Props, "snapshot" | "disabled" | "onDiscuss">
		& {
			onExplore: () => void;
			explore: RefObject<HTMLButtonElement | null>;
		},
) {
	let title = useId();
	let [sending, setSending] = useState(false);
	let [error, setError] = useState<string>();
	let pending = useRef(false);
	let recommendation = snapshot.recommendation;
	let evidence = snapshot.evidence.filter(item => recommendation.evidenceIds.includes(item.id));
	let discuss = async () => {
		if (disabled || pending.current) return;
		pending.current = true;
		setSending(true);
		setError(undefined);
		try {
			await onDiscuss(snapshot);
		} catch (failure) {
			setError(boundedChatError(failure));
		} finally {
			pending.current = false;
			setSending(false);
		}
	};
	return (
		<section
			aria-labelledby={title}
			className="build-recommendation"
			data-recommendation-key={snapshot.key}
		>
			<p className="build-recommendation-label">
				<LightbulbIcon aria-hidden="true" size={14} />Suggested next step
			</p>
			<h2 className="build-recommendation-title" id={title}>{recommendation.title}</h2>
			<p className="build-recommendation-scope">{recommendation.scope}</p>
			<UnfoldSection className="build-recommendation-details" label="Why this step">
				<ul className="build-recommendation-list">
					{recommendation.reasons.map(reason => <li key={reason}>{reason}</li>)}
				</ul>
				{recommendation.dependencies.length > 0 && (
					<UnfoldSection label="Needed for this step">
						<ul className="build-recommendation-list">
							{recommendation.dependencies.map(item => <li key={item}>{item}</li>)}
						</ul>
					</UnfoldSection>
				)}
				{recommendation.optional.length > 0 && (
					<UnfoldSection label="Can stay open">
						<ul className="build-recommendation-list">
							{recommendation.optional.map(item => <li key={item}>{item}</li>)}
						</ul>
					</UnfoldSection>
				)}
				{evidence.length > 0 && (
					<UnfoldSection label="Evidence">
						{evidence.map(item => (
							<UnfoldSection
								key={item.id}
								label={
									<span>
										<span className="build-recommendation-evidence-kind">{item.kind}</span> ·{" "}
										{item.label}
									</span>
								}
							>
								<p className="build-recommendation-evidence-detail">{item.detail}</p>
							</UnfoldSection>
						))}
					</UnfoldSection>
				)}
			</UnfoldSection>
			<p className="build-recommendation-boundary">
				A suggestion; Build plan still checks decisions and required investigations.
			</p>
			<div className="build-recommendation-actions">
				<button
					aria-busy={sending}
					className="btn btn-sm btn-outline"
					disabled={disabled || sending}
					onClick={() => void discuss()}
					type="button"
				>
					<MessageIcon aria-hidden="true" size={14} />Discuss with Chopin
				</button>
				<button className="btn btn-sm btn-ghost" onClick={onExplore} ref={explore} type="button">
					Keep exploring
				</button>
			</div>
			{error && <p className="build-recommendation-error" role="alert">{error}</p>}
		</section>
	);
}
