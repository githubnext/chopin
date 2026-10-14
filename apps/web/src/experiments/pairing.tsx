import { useEffect, useId, useRef, useState } from "react";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { ArrowLeftIcon, CheckIcon, MachineIcon, RestartIcon } from "@chopin/icons";
import { InlineNotice } from "@chopin/visuals/inline-notice";
import { motionImmediately } from "../motion-input";
import { AddServerPage } from "./add-server";
import { experimentRequest } from "./api";
import { AddComputerDialog, AddMachineMenu } from "./machine-setup";
import { Handshake, useMachines, useNewMachines, YourMachines } from "./machines";
import { pairingProblem } from "./pairing-problems";
import { SETUP_GUIDE } from "./setup-commands";

import type { ReactNode } from "react";
import type { MachineKind } from "./machine-setup";

import "./machines.css";

type Pairing = {
	input: { repository?: string; label: string };
	/** The GitHub login of the person signed in here, who approves the pairing. */
	owner: string;
	code: string;
	/** Connect goes by way of GitHub, which authorizes the machine on its own. */
	authorize?: boolean;
	/** Where to go once this pairing has its machine, after GitHub authorized it. */
	connected?: string;
};

/** How long a machine's tick holds before the dialog closes onto its row. */
const HOLD_MS = 1600;

/**
 * The frame every /connect view shares inside the navigation: the page title and its action, on
 * the ground, scrolling on its own. `lead` sits above the title, as Back does.
 */
function MachinesFrame(
	{ action, children, description, lead, title }: {
		action?: ReactNode;
		children: ReactNode;
		description: ReactNode;
		lead?: ReactNode;
		title: string;
	},
) {
	return (
		<div className="machines-page" data-hosted="">
			<main className="machines-main">
				<div className="machines-heading">
					{lead}
					<div className="machines-title">
						<div className="min-w-0">
							<h1 className="text-xl font-semibold">{title}</h1>
							<p className="machines-description mt-1 text-sm text-text-secondary">{description}</p>
						</div>
						{action}
					</div>
				</div>
				{children}
			</main>
		</div>
	);
}

/** Where /connect/server goes: the page for adding a server with a key. */
const SERVER_PATH = "/connect/server";

/**
 * The person's machines, under Add machine: Your computer opens a dialog with the command to run,
 * whose status waits for the machine; when it connects the status ticks, holds a moment, and the
 * dialog closes onto the machine's new row. Server or VM goes to its own page. With no machine
 * yet, a banner above the empty table offers the same menu.
 */
function MachinesHome({ login, onServer }: { login: string; onServer: () => void }) {
	let machines = useMachines();
	let list = machines.machines;
	let marks = useNewMachines(list);
	let bannerId = useId();
	let [adding, setAdding] = useState(false);
	let dialog = useTransitionPresence(adding ? true : undefined, 150, motionImmediately());
	let [announcement, setAnnouncement] = useState("");
	let announced = useRef<string>(undefined);
	// The machines there were as the dialog opened; one that wasn't is the one it waits for.
	let [before, setBefore] = useState<ReadonlySet<string>>();
	let hasList = !!list;
	useEffect(() => {
		if (!adding) setBefore(undefined);
		else if (hasList) setBefore(current => current ?? new Set(list?.map(machine => machine.id)));
	}, [adding, hasList, list]);
	let newcomer = before && list?.find(machine => !before.has(machine.id));
	let landed = newcomer?.connected ? newcomer : undefined;
	useEffect(() => {
		if (!landed) return;
		announced.current = landed.id;
		setAnnouncement(`${landed.label} connected`);
		let close = window.setTimeout(() => setAdding(false), HOLD_MS);
		return () => window.clearTimeout(close);
	}, [landed?.id, landed?.label]);
	// Other machines that turn up while the page is open are announced as they arrive.
	let arrived = marks.arrived;
	useEffect(() => {
		if (!arrived || adding || announced.current === arrived.id) return;
		announced.current = arrived.id;
		setAnnouncement(`${arrived.label} ${arrived.connected ? "connected" : "paired"}`);
	}, [arrived, adding]);
	let choose = (kind: MachineKind) => kind === "computer" ? setAdding(true) : onServer();
	return (
		<MachinesFrame
			action={<AddMachineMenu onChoose={choose} />}
			description={
				<>
					Machines run builds, investigations and Planners for your documents, with your own coding
					agent.{" "}
					<a className="machines-link" href={SETUP_GUIDE} rel="noreferrer" target="_blank">
						Learn more
					</a>
				</>
			}
			title="Machines"
		>
			<p className="sr-only" role="status">{announcement}</p>
			{list?.length === 0 && (
				<section aria-labelledby={bannerId} className="machines-banner">
					<h2 className="text-base font-semibold" id={bannerId}>Add your first machine</h2>
					<p className="machines-banner-copy">
						Chopin does its work on your machines. Add the computer you use, or a server that stays
						connected.
					</p>
					<div>
						<AddMachineMenu onChoose={choose} />
					</div>
				</section>
			)}
			<YourMachines fresh={marks.marked} machines={machines} />
			{dialog.phase !== "closed" && (
				<AddComputerDialog
					login={login}
					motion={dialog}
					onDismiss={() => setAdding(false)}
					status={<Handshake machine={newcomer} />}
				/>
			)}
		</MachinesFrame>
	);
}

/** /connect and /connect/server, switched in place, with Back and Forward between them. */
function MachinesPage({ login }: { login: string }) {
	let [server, setServer] = useState(() => location.pathname.replace(/\/$/, "") === SERVER_PATH);
	useEffect(() => {
		let changed = () => setServer(location.pathname.replace(/\/$/, "") === SERVER_PATH);
		window.addEventListener("popstate", changed);
		return () => window.removeEventListener("popstate", changed);
	}, []);
	let go = (path: string) => {
		history.pushState(null, "", path);
		setServer(path === SERVER_PATH);
		document.querySelector(".machines-page")?.scrollTo({ top: 0 });
	};
	if (server) {
		return (
			<MachinesFrame
				description="Choose settings, then generate an install script."
				lead={
					<a
						className="machines-back"
						href="/connect"
						onClick={event => {
							event.preventDefault();
							go("/connect");
						}}
					>
						<ArrowLeftIcon aria-hidden="true" size={14} />
						Back to Machines
					</a>
				}
				title="Add a server"
			>
				<AddServerPage onBack={() => go("/connect")} />
			</MachinesFrame>
		);
	}
	return <MachinesHome login={login} onServer={() => go(SERVER_PATH)} />;
}

/** How soon, and how many times, the list is asked again while the just-paired machine connects. */
const FOLLOW_MS = 500;
const FOLLOW_TRIES = 10;

/**
 * After pairing, the person's machines, the new one among them and marked New. The machine
 * connects a moment after Connect, so the list is asked again right away until it shows that,
 * rather than a poll later.
 */
function ConnectedMachines({ label }: { label: string }) {
	let machines = useMachines();
	let marks = useNewMachines(machines.machines);
	let mark = marks.mark;
	let retry = machines.retry;
	let tries = useRef(0);
	// Newest first, so the first of that name is the one just paired.
	let machine = machines.machines?.find(value => value.label === label);
	let paired = machine?.id;
	let waiting = !!machines.machines && !machine?.connected;
	useEffect(() => {
		if (paired) mark([paired]);
	}, [paired, mark]);
	useEffect(() => {
		if (!waiting || tries.current >= FOLLOW_TRIES) return;
		let timer = window.setTimeout(() => {
			tries.current++;
			retry();
		}, FOLLOW_MS);
		return () => window.clearTimeout(timer);
	}, [waiting, machines.machines, retry]);
	return <YourMachines fresh={marks.marked} machines={machines} />;
}

/** The pairing card's shape while the pairing is on its way. */
function PairingLoading() {
	return (
		<>
			<div aria-hidden="true" className="machines-card machines-skeleton-card">
				<span className="machines-skeleton-bar" data-width="name" />
				<span className="machines-skeleton-bar" data-width="code" />
				<span className="machines-skeleton-bar" data-width="detail" />
				<span className="machines-skeleton-bar" data-width="button" />
			</div>
			<p className="sr-only" role="status">Loading this pairing…</p>
		</>
	);
}

export default function PairingPage({ login }: { login: string }) {
	let id = new URLSearchParams(location.search).get("pairing");
	let [pairing, setPairing] = useState<Pairing>();
	let [loadError, setLoadError] = useState("");
	let [approveError, setApproveError] = useState("");
	let [attempt, setAttempt] = useState(0);
	let [busy, setBusy] = useState(false);
	let [url, setUrl] = useState("");
	// Off by default: without it, work reaches this machine only when its owner presses Build or
	// Run (apps/server/src/experiments/routes.ts runs pressed work on the presser's own connection).
	let [autoRun, setAutoRun] = useState(false);
	let helpId = useId();
	useEffect(() => {
		let abort = new AbortController();
		// Without a pairing, /connect lists the person's machines.
		if (!id) return;
		setLoadError("");
		experimentRequest<Pairing>(
			`/api/connector/pairings/${encodeURIComponent(id)}`,
			undefined,
			abort.signal,
		)
			.then(value => {
				setPairing(value);
				if (value.connected) setUrl(value.connected);
			}).catch(error => {
				if (!abort.signal.aborted) setLoadError(String(error?.message || "unavailable"));
			});
		return () => abort.abort();
	}, [id, attempt]);
	async function connect() {
		setBusy(true);
		setApproveError("");
		try {
			let result = await experimentRequest<{ url?: string; authorize?: string }>(
				`/api/connector/pairings/${encodeURIComponent(id!)}/approve`,
				{ autoRun },
			);
			// GitHub authorizes the machine on its own, then returns to this page.
			if (result.authorize) {
				location.assign(result.authorize);
				return;
			}
			setUrl(result.url ?? "/");
		} catch (error) {
			setApproveError(error instanceof Error && error.message ? error.message : "unavailable");
		} finally {
			setBusy(false);
		}
	}
	if (!id) return <MachinesPage login={login} />;
	let repository = pairing?.input.repository;
	let label = pairing?.input.label;
	let problem = loadError
		? pairingProblem(loadError, "load", repository)
		: approveError
		? pairingProblem(approveError, "approve", repository)
		: undefined;
	// A link that no longer works gives way to its notice; a failed Connect can be pressed again.
	let ended = !!loadError || !!problem && !problem.retry;
	return (
		<MachinesFrame
			description={url
				? `${label} now runs work for ${repository ?? "you"}.`
				: ended
				? "Chopin runs work for you on the machines you connect."
				: repository
				? `Connect this checkout of ${repository} so Chopin can run work for you in any of its documents.`
				: pairing
				? `Connect ${label} so Chopin can run work for you on it.`
				: "Chopin runs work for you on the machines you connect."}
			title={url ? "Machine connected" : ended ? "Connect a machine" : "Connect this machine?"}
		>
			{problem && (
				<InlineNotice
					actions={(ended || loadError) && (
						<>
							{problem.retry && loadError && (
								<button
									className="btn btn-compact btn-outline"
									onClick={() => setAttempt(value => value + 1)}
									type="button"
								>
									<RestartIcon aria-hidden="true" />
									Try again
								</button>
							)}
							<a className="btn btn-compact btn-outline" href="/connect">Go to your machines</a>
						</>
					)}
					message={problem.body}
					title={problem.title}
				/>
			)}
			{!pairing && !loadError && <PairingLoading />}
			{pairing && !ended && (
				<div className="machines-card">
					<div className="machines-pairing-label">
						<MachineIcon aria-hidden="true" className="machines-entry-icon" size={18} />
						<span className="machines-name font-medium">{label}</span>
						{repository && <span className="text-text-secondary">{repository}</span>}
						{!url && (
							<span className="machines-approver">
								Approving as <span className="font-medium text-text-primary">@{pairing.owner}</span>
							</span>
						)}
					</div>
					{url
						? (
							<>
								<p className="machines-paired" role="status">
									<CheckIcon aria-hidden="true" className="machines-handshake-check" size={16} />
									Connected
								</p>
								<a className="btn btn-md btn-primary self-start" href={url}>
									{repository ? `Open ${repository}` : "Open Chopin"}
								</a>
							</>
						)
						: (
							<>
								<div className="machines-code-check">
									<p className="m-0 text-text-secondary">
										Check that your terminal shows this code
									</p>
									<code className="machines-code">{pairing.code}</code>
								</div>
								<div className="machines-auto">
									<label className="machines-auto-label">
										<input
											aria-describedby={helpId}
											checked={autoRun}
											className="choice-control size-4 shrink-0"
											disabled={busy}
											onChange={event => setAutoRun(event.target.checked)}
											type="checkbox"
										/>
										<span>Let Chopin build and prototype automatically on this machine</span>
									</label>
									<p className="machines-detail machines-auto-help" id={helpId}>
										Off: work runs here only when you press Build or Run. On: Chopin can also
										rebuild what you built when its document changes, and prototype passages you
										write. Nobody else's work runs here.
									</p>
								</div>
								<div className="machines-pairing-actions">
									<button
										className="btn btn-md btn-primary"
										disabled={busy}
										onClick={() => void connect()}
										type="button"
									>
										Connect
									</button>
									{/* Nothing to cancel on the server: an unapproved pairing expires on its own. */}
									<a className="btn btn-md btn-ghost" href="/connect">Not my machine</a>
									{pairing.authorize && (
										<p className="machines-authorize-note">
											GitHub may ask you to authorize this machine.
										</p>
									)}
								</div>
							</>
						)}
				</div>
			)}
			{url && label && <ConnectedMachines label={label} />}
		</MachinesFrame>
	);
}
