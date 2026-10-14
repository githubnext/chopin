import { ClockIcon, LoaderIcon, ProgressRingIcon, WarningIcon } from "@chopin/icons";
import {
	lazy,
	Suspense,
	useEffect,
	useId,
	useLayoutEffect,
	useReducer,
	useRef,
	useState,
} from "react";

import {
	advanceFirstBuild,
	buildLabel,
	buildLook,
	buildPhase,
	buildRefusalCopy,
	buildTabReady,
	draftRefusalCopy,
	firstBuildStep,
	hasBuilt,
} from "./build-model";
import { ApiError } from "./api";
import { cancelBuildRequest, rebuildChanges, startBuild } from "./build-start";
import { useImplementationSnapshot } from "./implementation-snapshot";
import { BuildBlockerGlyph } from "./build-blocker-glyph";
import { buildBlockerSummary } from "./build-blockers";

import "./build-plan-button.css";
import "./build-blocker-popover.css";

import type { ReactNode } from "react";
import type { Implementation, ImplementationSnapshot } from "@chopin/protocol/implementation";
import type { BuildLook, FirstBuild } from "./build-model";
import type { Wire } from "./wire";
import type { BuildBlocker } from "./build-blockers";

const RELOAD_ON = [
	"plan:implementation",
	"plan:open",
	"implementation:readiness",
	"experiment:changed",
];
/** Edits only move a built document's change count, so they reload it at most this often. */
const EDIT_RELOAD_MS = 1000;
let BuildBlockerPopover = lazy(() =>
	import("./build-blocker-popover").then(module => ({ default: module.BuildBlockerPopover }))
);
let BuildConnectionPopover = lazy(() =>
	import("./build-connection-popover").then(module => ({ default: module.BuildConnectionPopover }))
);

/** The document's build, shared by the header capsule, the Build tab and the Build view. */
export type BuildPlan = {
	snapshot?: ImplementationSnapshot;
	loadError?: string;
	look: BuildLook;
	/** Build has something to show: a build, or a press under way. */
	tabReady: boolean;
	/** The last start found no local agent; Build says how to start one. */
	needsAgent: boolean;
	/** A press is drafting or starting the build, so another press would do nothing. */
	busy: boolean;
	/** Build plan, or Retry after a first build stopped. */
	press: () => void;
	/** Build the changes since the last build, or retry a failed one. */
	rebuild: () => void;
	/** Why the last Build or Retry of changes was refused. */
	rebuildError?: string;
	/** The last Build or Retry of changes found no local agent; Build says how to start one. */
	rebuildNeedsAgent: boolean;
	rebuilding: boolean;
	reload: () => void;
};

/**
 * Read the document's build and run Build plan's one press: ask the Planner for
 * tasks, then start them on the viewer's local agent. Nothing else sends
 * `implementation:draft`, so opening Build never spends a Planner turn.
 */
export function useBuildPlan(
	{
		canEdit,
		connected,
		enabled,
		hasContent,
		live,
		planner,
		plannerDetached,
		room,
		unanswered,
		userId,
		wire,
	}: {
		canEdit: boolean;
		connected: boolean;
		/** A parent document; a child is never built. */
		enabled: boolean;
		hasContent: boolean;
		live: boolean;
		planner: boolean;
		/** `session:planner` reports no Planner client attached (remote harness only). */
		plannerDetached?: boolean;
		room: string;
		unanswered: number;
		userId?: string;
		wire?: Wire;
	},
): BuildPlan {
	let { snapshot, loadError, refresh: reload, read } = useImplementationSnapshot({
		active: enabled,
		room,
		wire,
		reloadOn: RELOAD_ON,
	});
	let [state, dispatch] = useReducer(advanceFirstBuild, { stage: "idle" } as FirstBuild);
	let [rebuilding, setRebuilding] = useState(false);
	let [rebuildError, setRebuildError] = useState<string>();
	let [rebuildNeedsAgent, setRebuildNeedsAgent] = useState(false);
	let draftId = useRef<string>(undefined);

	useEffect(() => {
		dispatch({ type: "reset" });
	}, [room]);

	// A built document counts its edits since the build, so edits reload it, throttled.
	let built = !!snapshot && hasBuilt(snapshot);
	useEffect(() => {
		if (!enabled || !built) return;
		let timer: number | undefined;
		let edited = () => {
			timer ??= window.setTimeout(() => {
				timer = undefined;
				reload();
			}, EDIT_RELOAD_MS);
		};
		let off = ["plan:update", "plan:ack"].map(kind => wire?.on(kind, edited));
		return () => {
			off.forEach(remove => remove?.());
			window.clearTimeout(timer);
		};
	}, [enabled, built, wire]);

	// Whether the draft turn left tasks to start is only known from a fresh read.
	let drafted = async () => {
		draftId.current = undefined;
		try {
			let fresh = await read();
			let phase = buildPhase(fresh);
			dispatch({
				type: "draft-ended",
				drafted: phase.kind !== "drafting",
				changed: phase.kind === "drafting" && phase.draft === "revise",
			});
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
		if (!step.next || !canEdit) return;
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
				let copy = error instanceof Error
					? draftRefusalCopy(error.message, (error as { code?: string }).code)
					: undefined;
				dispatch({ type: "draft-refused", message: copy });
			});
			return;
		}
		if (!snapshot) return;
		dispatch({ type: "start" });
		startBuild(room, snapshot).then(result => {
			if (result === "started") {
				dispatch({ type: "started" });
				reload();
				return;
			}
			dispatch({ type: "start-refused", agent: true });
		}, error => {
			dispatch({
				type: "start-refused",
				agent: false,
				message: error instanceof Error ? buildRefusalCopy(error.message) : undefined,
			});
		});
	}, [step.next, snapshot?.revision, canEdit]);

	let look: BuildLook = enabled
		? buildLook(snapshot, {
			state,
			userId,
			live,
			canEdit,
			connected,
			planner,
			plannerDetached,
			hasContent,
			unanswered,
		})
		: { kind: "plan" as const, blocked: "A child document is never built" };
	// A refusal stands until the next press, or until a build of the changes is under way or done.
	useEffect(() => {
		if (look.kind === "rebuilding" || look.kind === "built") {
			setRebuildError(undefined);
			setRebuildNeedsAgent(false);
		}
	}, [look.kind]);
	return {
		snapshot,
		loadError,
		look,
		tabReady: enabled && buildTabReady(snapshot, look),
		needsAgent: state.stage === "failed" && !!state.agent,
		busy: state.stage === "drafting" || state.stage === "starting",
		press() {
			// The press drafts or starts against the latest revision, never a stale read.
			void read().catch(() => {}).finally(() => dispatch({ type: "press" }));
		},
		rebuild() {
			if (rebuilding) return;
			setRebuilding(true);
			setRebuildError(undefined);
			setRebuildNeedsAgent(false);
			rebuildChanges(room).then(reload, error => {
				setRebuildNeedsAgent(error instanceof ApiError && error.message === "no-workspace");
				setRebuildError(
					error instanceof ApiError && error.message === "no-workspace"
						? "Start your local agent, then build"
						: error instanceof Error
						? buildRefusalCopy(error.message)
						: "Chopin couldn’t start the build",
				);
				reload();
			}).finally(() => setRebuilding(false));
		},
		rebuildError,
		rebuildNeedsAgent,
		rebuilding,
		reload,
	};
}

/**
 * The build's one glyph, identical in the header capsule, on the Build tab and in
 * Build's headline, so the three read as the same thing. Nothing before a build.
 */
export function BuildGlyph(
	{ look, blockers }: { look: BuildLook; blockers?: readonly BuildBlocker[] },
) {
	if ("blocked" in look && look.blocked && blockers?.length) {
		return (
			<span className="build-glyph" aria-hidden="true">
				<BuildBlockerGlyph tone={buildBlockerSummary(blockers).tone} />
			</span>
		);
	}
	let inner = look.kind === "tasks" || look.kind === "rebuilding"
		? <LoaderIcon aria-hidden="true" className="build-glyph-spin" />
		: look.kind === "building"
		? <ProgressRingIcon progress={look.done / look.total} />
		: look.kind === "built"
		? <span className="build-glyph-dot" data-tone="success" />
		: look.kind === "stale"
		? look.live
			? <ClockIcon aria-hidden="true" className="build-glyph-quiet" />
			: <span className="build-glyph-dot" data-tone="warning" />
		: look.kind === "stopped" || look.kind === "failed" || look.kind === "agent"
		? <WarningIcon aria-hidden="true" className="build-glyph-warning" />
		: undefined;
	if (!inner) return null;
	return <span aria-hidden="true" className="build-glyph" data-build-glyph="">{inner}</span>;
}

/** Read a duration token, so the hand-off keeps the design system's timing. */
function duration(name: string, fallback: number): number {
	let value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	let ms = value.endsWith("ms") ? parseFloat(value) : parseFloat(value) * 1000;
	return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

/**
 * On the first press only, the glyph travels from the capsule to the Build tab as
 * the tab turns on, teaching where the status lives. Transform and opacity only.
 */
function handOff(from: HTMLElement) {
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	let target = [...document.querySelectorAll<HTMLElement>("[data-build-tab-glyph]")]
		.find(element => element.getClientRects().length > 0);
	let start = from.getBoundingClientRect();
	let end = target?.getBoundingClientRect();
	if (!target || !end || start.width === 0) return;
	let flyer = from.cloneNode(true) as HTMLElement;
	flyer.classList.add("build-glyph-flyer");
	document.body.append(flyer);
	target.dataset.landing = "";
	let dx = end.left - start.left;
	let style = getComputedStyle(document.documentElement);
	let motion = flyer.animate(
		[
			{ transform: `translate(${start.left}px, ${start.top}px) scale(1)` },
			{
				transform: `translate(${start.left + dx / 2}px, ${
					Math.min(start.top, end.top) - 12
				}px) scale(1.4)`,
				offset: 0.45,
			},
			{ transform: `translate(${end.left}px, ${end.top}px) scale(1)` },
		],
		{
			duration: duration("--duration-linger", 600) * 1.4,
			easing: style.getPropertyValue("--motion-smooth-out").trim() || "ease-out",
		},
	);
	let finish = () => {
		flyer.remove();
		delete target.dataset.landing;
	};
	motion.addEventListener("finish", finish);
	motion.addEventListener("cancel", finish);
}

/**
 * The header's build slot, beside the people here. Named blockers replace Build
 * plan with a capsule; missing connections offer setup. After the press the
 * same slot names the build's state and opens Build, including while Build is open.
 */
export function BuildPlanButton(
	{
		blockers,
		build,
		canEdit,
		compact,
		documentURL,
		hot,
		machine,
		machineOffline,
		onBlockerSelect,
		onExplain,
		onHover,
		onOpen,
		phone,
		tabReady = true,
	}: {
		blockers?: readonly BuildBlocker[];
		build: BuildPlan;
		/** The machine button, beside Build plan or its capsule. */
		machine?: ReactNode;
		/**
		 * The machine the person chose is offline, named: Build plan is dimmed and starts nothing, and
		 * this is its accessible description.
		 */
		machineOffline?: string;
		canEdit: boolean;
		/** Phone: the glyph alone; Build's headline carries the words. */
		compact?: boolean;
		documentURL?: string;
		/** The Build tab is hovered. */
		hot?: boolean;
		onHover: (on: boolean) => void;
		onOpen: () => void;
		onBlockerSelect?: (blocker: BuildBlocker) => void;
		/** Phone: touch has no tooltip, so a tap that cannot act shows this reason instead. */
		onExplain?: (reason: string) => void;
		/** A phone's top bar: the status and its action read as links in the title's subtitle. */
		phone?: boolean;
		/** Build can open; until then a phone tap on the glyph explains instead. */
		tabReady?: boolean;
	},
) {
	let { look } = build;
	let reason = useId();
	let actionReason = useId();
	// Announce a change of state politely, once, not every tip or count that follows it.
	let [announcement, setAnnouncement] = useState("");
	let announced = useRef(look.kind);
	useEffect(() => {
		if (announced.current === look.kind) return;
		announced.current = look.kind;
		setAnnouncement(
			look.kind === "plan"
				? ""
				: `${buildLabel(look)}. ${"tip" in look && look.tip ? look.tip : ""}`,
		);
	}, [look]);
	let live = (
		// A polite live region without the status role: the header holds no status of its own.
		<span aria-atomic="true" aria-live="polite" className="sr-only" key="live">
			{announcement}
		</span>
	);
	let glyph = useRef<HTMLSpanElement>(null);
	let pressed = useRef(false);
	let handedOff = useRef(false);
	let previous = useRef(look.kind);
	useEffect(() => {
		if (compact && build.rebuildError) onOpen();
	}, [build.rebuildError]);
	useLayoutEffect(() => {
		let was = previous.current;
		previous.current = look.kind;
		if (!pressed.current || was !== "plan" || look.kind === "plan" || handedOff.current) return;
		pressed.current = false;
		handedOff.current = true;
		let from = glyph.current?.querySelector<HTMLElement>("[data-build-glyph]");
		if (from) handOff(from);
	}, [look.kind]);

	if (canEdit && "blocked" in look && look.blocked && blockers?.length && onBlockerSelect) {
		let summary = buildBlockerSummary(blockers);
		return (
			<span className={phone ? "build-status" : "build-capsule-row"}>
				<Suspense
					fallback={
						<span
							aria-busy="true"
							className={phone
								? "build-status build-blocker-capsule"
								: "build-capsule build-blocker-capsule"}
							data-tone={summary.tone}
						>
							<BuildBlockerGlyph tone={summary.tone} />
							<span className="build-capsule-label">{summary.label}</span>
						</span>
					}
				>
					<BuildBlockerPopover
						hot={hot}
						items={blockers}
						onHover={onHover}
						onSelect={onBlockerSelect}
						phone={phone}
					/>
				</Suspense>
				{machine}
				{live}
			</span>
		);
	}
	let connectionReason = ("blocked" in look ? look.blocked : undefined)
		?? ("tip" in look ? look.tip : undefined);
	if (canEdit && documentURL && connectionReason?.startsWith("Connect a Planner")) {
		return (
			<>
				<Suspense fallback={<span className="text-sm text-text-secondary">Connect Chopin</span>}>
					<BuildConnectionPopover documentURL={documentURL} kind="planner" phone={phone} />
				</Suspense>
				{machine}
				{live}
			</>
		);
	}
	if (look.kind === "plan") {
		if (!canEdit) return null;
		let blocked = look.blocked;
		// The chosen machine is offline: dimmed as the machine button beside it is, still focusable,
		// with the reason only in its accessible description. Pressing it does nothing.
		let offline = blocked ? undefined : machineOffline;
		return (
			<>
				<button
					aria-label="Build plan"
					aria-describedby={blocked || offline ? reason : undefined}
					aria-disabled={blocked || offline ? true : undefined}
					className={`${
						phone ? "build-status-link" : "btn btn-compact btn-primary build-plan shrink-0"
					}${offline ? " machine-offline" : ""}`}
					data-tooltip={blocked === "Chopin isn’t running for this document"
						? "Chopin is off"
						: blocked}
					data-tooltip-detail={blocked ? "" : undefined}
					data-tooltip-verbatim={blocked ? "" : undefined}
					onClick={() => {
						if (blocked) {
							onExplain?.(blocked);
							return;
						}
						// Nothing starts, not even the Planner's draft, on a machine that is offline.
						if (offline) return;
						pressed.current = true;
						build.press();
					}}
					type="button"
				>
					Build plan
				</button>
				{(blocked || offline) && <span className="sr-only" id={reason}>{blocked ?? offline}</span>}
				{machine}
				{live}
			</>
		);
	}
	let connectAgent = canEdit && documentURL
		&& (look.kind === "agent" || build.needsAgent || build.rebuildNeedsAgent);
	let label = connectAgent && look.kind === "agent" ? "Agent offline" : buildLabel(look);
	let blocked = look.kind === "stale" || look.kind === "failed" ? look.blocked : undefined;
	let action = (look.kind === "stopped" || look.kind === "agent") && look.retry && canEdit
		? { name: "Retry", run: build.press }
		: look.kind === "failed" && look.retry && canEdit
		? { name: "Retry", run: build.rebuild }
		: look.kind === "stale" && look.build && canEdit
		// Compact names what it builds; a phone's subtitle follows the status, which already says.
		? { name: compact && !phone ? "Build changes" : "Build", run: build.rebuild }
		: undefined;
	let refused = action?.run === build.rebuild ? build.rebuildError : undefined;
	let busy = build.busy || build.rebuilding;
	return (
		<>
			<span className={phone ? "build-status" : "build-capsule-row"} key="capsule">
				<button
					aria-describedby={look.tip ? reason : undefined}
					aria-label={compact ? label : undefined}
					className={phone ? "build-status-link" : "build-capsule"}
					data-compact={compact || undefined}
					data-hot={hot || undefined}
					data-tooltip={connectAgent
						? "Local agent disconnected"
						: compact
						? `${label} · ${look.tip}`
						: look.tip}
					data-tooltip-detail=""
					data-tooltip-verbatim=""
					onBlur={() => onHover(false)}
					onClick={() => {
						if (blocked && onExplain) onExplain(blocked);
						else if (!tabReady && onExplain) onExplain(look.tip ?? label);
						else onOpen();
					}}
					onFocus={() => onHover(true)}
					onPointerEnter={() => onHover(true)}
					onPointerLeave={() => onHover(false)}
					type="button"
				>
					<span className="build-capsule-glyph" ref={glyph}>
						<BuildGlyph look={look} />
					</span>
					{(!compact || phone) && (
						<span className="build-capsule-label" key={label}>
							{/* Beside its Build, a phone's narrow subtitle needs only the count. */}
							{phone && action && look.kind === "stale"
								? `${look.changes} ${look.changes === 1 ? "change" : "changes"}`
								: label}
						</span>
					)}
				</button>
				{look.tip && <span className="sr-only" id={reason}>{look.tip}</span>}
				{connectAgent
					? (
						<Suspense fallback={<span className="text-sm text-text-secondary">Connect agent</span>}>
							<BuildConnectionPopover
								documentURL={documentURL!}
								kind="agent"
								outline
								phone={phone}
							/>
						</Suspense>
					)
					: action && (
						<>
							{phone && <span aria-hidden="true">·</span>}
							{/* Stays focusable while blocked or busy; aria-disabled and aria-busy say why. */}
							<button
								aria-busy={busy || undefined}
								aria-describedby={blocked ? actionReason : undefined}
								aria-disabled={blocked || busy ? true : undefined}
								className={phone
									? "build-status-link build-capsule-action"
									: "btn btn-compact btn-outline build-capsule-action"}
								data-tooltip={blocked}
								data-tooltip-detail={blocked ? "" : undefined}
								data-tooltip-verbatim={blocked ? "" : undefined}
								onClick={() => {
									if (blocked) onExplain?.(blocked);
									else if (!busy) action.run();
								}}
								type="button"
							>
								{action.name}
							</button>
							{blocked && <span className="sr-only" id={actionReason}>{blocked}</span>}
						</>
					)}
				{machine}
				{/* On a phone the refusal is read in Build's headline, which opens with it. */}
				{refused && !connectAgent && (
					<span className={compact ? "sr-only" : "build-capsule-refusal"} role="alert">
						{refused}
					</span>
				)}
			</span>
			{live}
		</>
	);
}
