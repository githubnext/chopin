import type { Session } from "@chopin/protocol";

/**
 * Who holds this document's remote Planner, beneath the composer, so nobody has
 * to ask a terminal before typing @chopin. Only `HARNESS=remote` reports one; with
 * no report this renders nothing. The words carry the state and the dot repeats it.
 * `machine` names the viewer's own machine that is starting it, which only they see.
 * Once that machine's backend has failed to start more than once in a row, the line says why,
 * for everyone in the document, and is still the starting state: the machine keeps trying.
 */
export function PlannerAttachment(
	{ planner, machine }: { planner: Session.PlannerAttachment | undefined; machine?: string },
) {
	if (!planner) return null;
	let failure = planner.state === "starting" ? planner.failure : undefined;
	return (
		<p
			className="composer-planner"
			data-planner-state={planner.state}
			{...(failure ? { "data-planner-failing": "" } : {})}
			role="status"
		>
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
					: planner.state === "starting" && failure
					? (
						<>
							<span className="composer-planner-lead">
								{`Planner: can’t start on ${machine ?? `@${planner.login}’s machine`}`}
							</span>{" "}
							<span className="composer-planner-reason">{failure.reason}</span>{" "}
							<span className="composer-planner-meta">
								{`Tried ${failure.attempts} times in a row, last at `}
								<time dateTime={failure.at}>
									{new Date(failure.at).toLocaleTimeString([], {
										hour: "2-digit",
										minute: "2-digit",
									})}
								</time>
								. Still trying.
							</span>
						</>
					)
					: planner.state === "starting"
					? `Planner: starting on ${machine ?? `@${planner.login}’s machine`}…`
					: "Planner: none attached. @chopin needs an attached Planner."}
			</span>
		</p>
	);
}
