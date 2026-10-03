import type { ConversationPlan } from "@chopin/protocol";

export type SourceDestination = { source: ConversationPlan.SourceRef; itemId: string };

export function Sources({ itemId, onSource, sources }: {
	itemId: string;
	onSource: (destination: SourceDestination) => void;
	sources: ConversationPlan.SourceRef[];
}) {
	if (sources.length === 0) return null;
	return (
		<span className="inline-flex flex-wrap gap-1">
			{sources.map((source, index) => (
				<button
					aria-label={`Show source for ${source.role}: ${source.quote}`}
					className="rounded px-1.5 py-0.5 text-xs text-brand hover:bg-hover"
					key={`${source.messageId}-${source.start}-${index}`}
					onClick={() => onSource({ itemId, source })}
					title={`${
						source.author.kind === "member" ? source.author.handle : "Planner"
					}: “${source.quote}”`}
					type="button"
				>
					Source{sources.length > 1 ? ` ${index + 1}` : ""}
				</button>
			))}
		</span>
	);
}
