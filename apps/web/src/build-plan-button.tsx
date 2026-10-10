import { CheckIcon, LoaderIcon } from "@chopin/icons";
import { useEffect, useReducer, useRef, useState } from "react";

import {
	advanceFirstBuild,
	buildPhase,
	draftRefusalCopy,
	firstBuildStep,
	startingLabel,
	syncLabel,
	syncStatus,
	syncTooltip,
	waitingLabel,
} from "./build-model";
import {
	cancelBuildRequest,
	implementationEndpoint,
	implementationResponse,
	startBuild,
} from "./build-start";

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
	{ onNeedsAgent, onShowBuild, onShowDecisions, room, userId, wire }: {
		/** No local agent could take the build; the Build view explains how to start one. */
		onNeedsAgent: () => void;
		onShowBuild: () => void;
		onShowDecisions: () => void;
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

	// A failed attempt gives up the server's request, so a reload does not try it again.
	useEffect(() => {
		if (state.stage === "failed" && snapshot?.buildRequested?.by === userId) {
			void cancelBuildRequest(room).catch(() => {});
		}
	}, [state.stage]);

	let step = firstBuildStep(snapshot, state, userId);
	useEffect(() => {
		if (!step.next) return;
		if (step.next === "reset" || step.next === "resume" || step.next === "wait") {
			dispatch({ type: step.next });
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
				build: true,
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
		let hint = syncTooltip(sync, snapshot, userId);
		return (
			<button
				aria-busy={sync.kind === "building" || undefined}
				aria-description={hint}
				className="btn btn-compact btn-ghost shrink-0"
				data-build-slot=""
				data-sync={sync.kind}
				data-tooltip={hint}
				data-tooltip-detail=""
				data-tooltip-verbatim=""
				onClick={onShowBuild}
				type="button"
			>
				{sync.kind === "building" && <LoaderIcon aria-hidden="true" data-button-loader="" />}
				{sync.kind === "in-sync" && <CheckIcon aria-hidden="true" className="text-text-tertiary" />}
				{(sync.kind === "out-of-sync" || sync.kind === "needs-attention") && (
					<span
						aria-hidden="true"
						className="build-task-dot"
						data-state={sync.kind === "needs-attention" || sync.reason === "failed"
							? "blocked"
							: "queued"}
					/>
				)}
				{syncLabel(sync)}
			</button>
		);
	}
	if (step.view === "hidden") return null;
	if (step.view === "waiting") {
		let { label, target } = waitingLabel(snapshot);
		let hint = target === "decisions"
			? "The build starts once the open decisions are answered"
			: "The build starts once the document is updated";
		return (
			<button
				aria-description={hint}
				className="btn btn-compact btn-ghost shrink-0"
				data-build-slot=""
				data-tooltip={hint}
				data-tooltip-detail=""
				data-tooltip-verbatim=""
				onClick={target === "decisions" ? onShowDecisions : onShowBuild}
				type="button"
			>
				<span aria-hidden="true" className="build-task-dot" data-state="queued" />
				{label}
			</button>
		);
	}
	if (step.view === "working") {
		let { hint, label, queued } = startingLabel(snapshot);
		return (
			<button
				aria-busy="true"
				aria-description={hint}
				className="btn btn-compact btn-ghost shrink-0"
				data-build-slot=""
				data-tooltip={hint}
				data-tooltip-detail={hint ? "" : undefined}
				data-tooltip-verbatim={hint ? "" : undefined}
				onClick={onShowBuild}
				type="button"
			>
				{queued
					? <span aria-hidden="true" className="build-task-dot" data-state="queued" />
					: <LoaderIcon aria-hidden="true" data-button-loader="" />}
				{label}
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
				data-build-slot=""
				data-tooltip={failure}
				data-tooltip-detail={failure ? "" : undefined}
				data-tooltip-verbatim={failure ? "" : undefined}
				onClick={() => dispatch({ type: "press" })}
				type="button"
			>
				{/* A failed attempt stays visible after the alert, not only on hover. */}
				{failure && <span aria-hidden="true" className="build-task-dot" data-state="blocked" />}
				{failure ? "Retry build" : "Build plan"}
			</button>
			{failure && <span className="sr-only" role="alert">{failure}</span>}
		</>
	);
}
