import { DocumentIcon, WarningIcon } from "@chopin/icons";

import type { Relation } from "../relation";

const ORDER: Relation[] = ["orphaned", "pending", "linked", "empty"];

/** One state for a card, and the question a linked card points through. */
export function cardRelation(
	relations: Record<string, Relation> | undefined,
	questions: string[],
): { relation: Relation; question: string } | undefined {
	if (!relations) return undefined;
	for (let relation of ORDER) {
		let question = questions.find(id => relations[id] === relation);
		if (question) return { relation, question };
	}
	return undefined;
}

const ROW = "inline-flex min-w-0 items-center gap-1.5 text-xs";

export function RelationNote(
	{ count = 0, onEnter, onLeave, onSelect, pending = "Linking…", question, relation }: {
		count?: number;
		onEnter?: (question: string) => void;
		onLeave?: (question: string) => void;
		onSelect?: (question: string) => void;
		/** A host that knows what the wait is for can say so. */
		pending?: string;
		question: string;
		relation: Relation;
	},
) {
	if (relation === "linked") {
		if (!onSelect) return null;
		return (
			<button
				aria-label={count > 1 ? `Show in document, ${count} places` : "Show in document"}
				className={`btn btn-sm btn-ghost -mx-1 ${ROW} text-text-secondary`}
				data-relation="linked"
				onBlur={event => !event.currentTarget.matches(":hover") && onLeave?.(question)}
				onClick={() => onSelect(question)}
				onFocus={() => onEnter?.(question)}
				onMouseEnter={() => onEnter?.(question)}
				onMouseLeave={event =>
					event.currentTarget !== document.activeElement && onLeave?.(question)}
				type="button"
			>
				<DocumentIcon aria-hidden="true" size={12} />
				<span>Show in document</span>
				{count > 1 && (
					<span aria-hidden="true" className="text-text-tertiary tabular-nums">{count}</span>
				)}
			</button>
		);
	}

	if (relation === "pending") {
		return (
			<span className={`${ROW} px-1 text-text-tertiary`} data-relation="pending" role="status">
				<span aria-hidden="true" className="question-relation-dot size-1.5 rounded-full" />
				<span>{pending}</span>
			</span>
		);
	}

	if (relation === "orphaned") {
		return (
			<span className={`${ROW} px-1 text-warning-ink`} data-relation="orphaned">
				<WarningIcon aria-hidden="true" size={12} />
				<span>Related text was removed</span>
			</span>
		);
	}

	return (
		<span className={`${ROW} px-1 text-text-tertiary`} data-relation="empty">
			<DocumentIcon aria-hidden="true" className="text-text-quaternary" size={12} />
			<span>No related text</span>
		</span>
	);
}
