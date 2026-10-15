import type { Session } from "@chopin/protocol";

/**
 * Who holds this document's remote Planner, beneath the composer, so nobody has
 * to ask a terminal before typing @chopin. Only `HARNESS=remote` reports one; with
 * no report this renders nothing. The words carry the state and the dot repeats it.
 * `machine` names the viewer's own machine that is starting it, which only they see.
 */
export function PlannerAttachment(
	{ planner, machine }: { planner: Session.PlannerAttachment | undefined; machine?: string },
) {
	if (!planner) return null;
	return (
		<p className="composer-planner" data-planner-state={planner.state} role="status">
			<span aria-hidden="true" className="composer-planner-dot" />
			<span className="composer-planner-label">
				{planner.state === "attached"
					? `Planner: ${planner.login} attached`
					: planner.state === "held"
					? (
						<>
							{`Planner: ${planner.login} detached, held until `}
							<time dateTime={planner.until}>
								{new Date(planner.until).toLocaleTimeString([], {
									hour: "2-digit",
									minute: "2-digit",
								})}
							</time>
						</>
					)
					: planner.state === "starting"
					? `Planner: starting on ${machine ?? `@${planner.login}’s machine`}…`
					: "Planner: none attached. @chopin needs an attached Planner."}
			</span>
		</p>
	);
}
