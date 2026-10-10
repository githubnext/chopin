import { CheckIcon, LoaderIcon } from "@chopin/icons";
import { useEffect, useReducer, useRef, useState } from "react";

import {
	advanceFirstBuild,
	buildPhase,
	draftRefusalCopy,
	firstBuildStep,
	startingHint,
	SYNC_LABEL,
	syncHint,
	syncStatus,
} from "./build-model";
import { implementationEndpoint, implementationResponse, startBuild } from "./build-start";

import type { Implementation, ImplementationSnapshot } from "@chopin/protocol/implementation";
import type { FirstBuild } from "./build-model";
import type { Wire } from "./wire";

const RELOAD_ON = [
	"plan:implementation",
	"plan:open",
	"implementation:readiness",
	"experiment:changed",
];

/**
 * The document's first build in one press: ask the Planner for tasks, then
 * start them on the viewer's local agent. The Build view owns every later build.
 * Once that build has delivered, the slot quietly reports whether the pull
 * requests still match the living document.
 */
export function BuildPlanButton(
	{ onNeedsAgent, onShowBuild, room, userId, wire }: {
		/** No local agent could take the build; the Build view explains how to start one. */
		onNeedsAgent: () => void;
		onShowBuild: () => void;
		room: string;
		userId?: string;
		wire?: Wire;
	},
) {
	let [snapshot, setSnapshot] = useState<ImplementationSnapshot>();
	let [refresh, setRefresh] = useState(0);
	let [state, dispatch] = useReducer(advanceFirstBuild, { stage: "idle" } as FirstBuild);
	let draftId = useRef<string>(undefined);
	let endpoint = implementationEndpoint(room);

	let read = async (signal?: AbortSignal) => {
		let value = await implementationResponse<ImplementationSnapshot>(
			await fetch(endpoint, { signal, cache: "no-store" }),
		);
		setSnapshot(current => !current || value.revision >= current.revision ? value : current);
		return value;
	};

	useEffect(() => {
		let controller = new AbortController();
		read(controller.signal).catch(() => {});
		return () => controller.abort();
	}, [endpoint, refresh]);

	useEffect(() => {
		let reload = () => setRefresh(value => value + 1);
		let off = RELOAD_ON.map(kind => wire?.on(kind, reload));
		return () => off.forEach(remove => remove?.());
	}, [wire]);

	// Whether the draft turn left tasks to start is only known from a fresh read.
	let drafted = async () => {
		draftId.current = undefined;
		try {
			let fresh = await read();
			dispatch({ type: "draft-ended", drafted: buildPhase(fresh).kind !== "drafting" });
		} catch {
			dispatch({ type: "draft-ended", drafted: false });
		}
	};

	useEffect(
		() =>
			wire?.on<Implementation.Drafting>("implementation:drafting", frame => {
				if (frame.id === draftId.current && frame.state === "ended") void drafted();
			}),
		[wire],
	);

	let step = firstBuildStep(snapshot, state);
	useEffect(() => {
		if (!step.next) return;
		if (step.next === "reset") {
			dispatch({ type: "reset" });
			return;
		}
		if (step.next === "draft") {
			if (!snapshot || !wire?.connected) {
				dispatch({ type: "draft-refused", message: "Chopin isn’t connected." });
				return;
			}
			dispatch({ type: "draft-sent" });
			void wire.ask<Implementation.Drafted>("implementation:draft", {
				requestId: crypto.randomUUID(),
				planRevision: snapshot.planRevision,
			}).then(answer => {
				draftId.current = answer.id;
				if (answer.state === "ended") void drafted();
			}, error => {
				let copy = error instanceof Error ? draftRefusalCopy(error.message) : undefined;
				dispatch({ type: "draft-refused", message: copy });
			});
			return;
		}
		if (!snapshot) return;
		dispatch({ type: "start" });
		startBuild(room, snapshot).then(result => {
			if (result === "started") {
				dispatch({ type: "started" });
				setRefresh(value => value + 1);
				return;
			}
			dispatch({ type: "start-refused", agent: true });
			onNeedsAgent();
		}, error => {
			dispatch({
				type: "start-refused",
				agent: false,
				message: error instanceof Error
					? error.message.replace(/^[a-z]/, letter => letter.toUpperCase())
					: undefined,
			});
		});
	}, [step.next, snapshot?.revision]);

	let sync = syncStatus(snapshot);
	if (sync) {
		let hint = syncHint(sync, snapshot, userId);
		return (
			<button
				aria-busy={sync.kind === "building" || undefined}
				aria-description={hint}
				className="btn btn-compact btn-ghost shrink-0"
				data-sync={sync.kind}
				data-tooltip={hint}
				data-tooltip-detail={hint ? "" : undefined}
				data-tooltip-verbatim={hint ? "" : undefined}
				onClick={onShowBuild}
				type="button"
			>
				{sync.kind === "building" && <LoaderIcon aria-hidden="true" data-button-loader="" />}
				{sync.kind === "in-sync" && <CheckIcon aria-hidden="true" className="text-text-tertiary" />}
				{sync.kind === "out-of-sync" && (
					<span
						aria-hidden="true"
						className="build-task-dot"
						data-state={sync.reason === "failed" ? "blocked" : "queued"}
					/>
				)}
				{SYNC_LABEL[sync.kind]}
			</button>
		);
	}
	if (step.view === "hidden") return null;
	if (step.view === "working") {
		let hint = startingHint(snapshot);
		return (
			<button
				aria-busy="true"
				aria-description={hint}
				className="btn btn-compact btn-ghost shrink-0"
				data-tooltip={hint}
				data-tooltip-detail={hint ? "" : undefined}
				data-tooltip-verbatim={hint ? "" : undefined}
				onClick={onShowBuild}
				type="button"
			>
				<LoaderIcon aria-hidden="true" data-button-loader="" />
				Building…
			</button>
		);
	}
	let failure = state.stage === "failed" && !state.agent
		? state.message ?? "Chopin couldn’t start the build."
		: undefined;
	return (
		<>
			<button
				className="btn btn-compact btn-outline shrink-0"
				data-tooltip={failure}
				data-tooltip-verbatim={failure ? "" : undefined}
				onClick={() => dispatch({ type: "press" })}
				type="button"
			>
				Build plan
			</button>
			{failure && <span className="sr-only" role="alert">{failure}</span>}
		</>
	);
}
