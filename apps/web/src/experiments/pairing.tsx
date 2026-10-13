import { useEffect, useId, useState } from "react";
import { MachineIcon } from "@chopin/icons";
import { UnfoldPanel, useUnfold } from "@chopin/visuals/unfold";
import chopinIcon from "../assets/figma/navigation/chopin.svg";
import { experimentRequest } from "./api";
import { MachineSetup } from "./machine-setup";
import { MachineTable, useMachines } from "./machines";

import type { ReactNode } from "react";

import "./machines.css";

type Pairing = {
	input: { repository?: string; label: string };
	owner: string;
	code: string;
	/** Where to go once this pairing has its machine, after GitHub authorized it. */
	connected?: string;
};

/** The frame every /connect view shares: Chopin's header, then the page title and its action. */
function MachinesFrame(
	{ action, children, description, title }: {
		action?: ReactNode;
		children: ReactNode;
		description: string;
		title: string;
	},
) {
	return (
		<div className="sign-in-page" data-hosted="">
			<header className="sign-in-header">
				<a className="machines-home" href="/">
					<img alt="" height={16} src={chopinIcon} width={16} />
					<span className="text-sm font-semibold text-brand">Chopin</span>
				</a>
				<span className="text-sm text-text-tertiary">A GitHub Next research prototype</span>
			</header>
			<main className="machines-main">
				<div className="machines-title">
					<div className="min-w-0">
						<h1 className="text-xl font-semibold">{title}</h1>
						<p className="mt-1 text-sm text-text-secondary">{description}</p>
					</div>
					{action}
				</div>
				{children}
			</main>
		</div>
	);
}

/** The person's machines, and what to run to add one. */
function YourMachines(
	{ machines }: { machines: ReturnType<typeof useMachines> },
) {
	let headingId = useId();
	let list = machines.machines;
	return (
		<section aria-labelledby={headingId} className="machines-section">
			<h2 className="text-base font-semibold" id={headingId}>Your machines</h2>
			{machines.error && (
				<p className="m-0 text-sm text-destructive-ink" role="alert">{machines.error}</p>
			)}
			{list?.length === 0 && (
				<p className="machines-waiting" role="status">
					<MachineIcon aria-hidden="true" className="machines-entry-icon" size={18} />
					Waiting for your machine…
				</p>
			)}
			{!!list?.length && (
				<MachineTable
					labelledBy={headingId}
					machines={list}
					onForget={machines.forget}
					recommended={machines.recommended}
				/>
			)}
		</section>
	);
}

function MachinesPage() {
	let machines = useMachines();
	let unfold = useUnfold();
	let setupId = useId();
	let first = machines.machines?.length === 0;
	return (
		<MachinesFrame
			action={!!machines.machines?.length && (
				<button
					aria-controls={unfold.id}
					aria-expanded={unfold.open}
					className="btn btn-md btn-primary shrink-0"
					onClick={unfold.toggle}
					ref={unfold.trigger.ref}
					type="button"
				>
					Add a machine
				</button>
			)}
			description="Machines run builds, investigations and Planners for your documents, with your own coding agent."
			title="Machines"
		>
			{first && <MachineSetup headingId={setupId} title="Add your first machine" />}
			<div>
				{!!machines.machines?.length && (
					<UnfoldPanel unfold={unfold}>
						<div className="machines-setup-fold">
							<MachineSetup headingId={setupId} title="Add a machine" />
						</div>
					</UnfoldPanel>
				)}
				<YourMachines machines={machines} />
			</div>
		</MachinesFrame>
	);
}

/** After pairing, the person's machines, the new one among them. */
function ConnectedMachines() {
	let machines = useMachines();
	return <YourMachines machines={machines} />;
}

export default function PairingPage() {
	let id = new URLSearchParams(location.search).get("pairing");
	let [pairing, setPairing] = useState<Pairing>();
	let [error, setError] = useState("");
	let [busy, setBusy] = useState(false);
	let [url, setUrl] = useState("");
	// Off by default: without it, work reaches this machine only when a person presses Build or Run.
	let [autoRun, setAutoRun] = useState(false);
	useEffect(() => {
		let abort = new AbortController();
		// Without a pairing, /connect lists the person's machines.
		if (!id) return;
		experimentRequest<Pairing>(
			`/api/connector/pairings/${encodeURIComponent(id)}`,
			undefined,
			abort.signal,
		)
			.then(value => {
				setPairing(value);
				if (value.connected) setUrl(value.connected);
			}).catch(error => {
				if (!abort.signal.aborted) setError(String(error.message));
			});
		return () => abort.abort();
	}, [id]);
	async function connect() {
		setBusy(true);
		setError("");
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
			setError(error instanceof Error ? error.message : "Connection failed");
		} finally {
			setBusy(false);
		}
	}
	if (!id) return <MachinesPage />;
	let repository = pairing?.input.repository;
	return (
		<MachinesFrame
			description={repository
				? `Connect this checkout of ${repository} so Chopin can run work for you in any of its documents.`
				: pairing
				? `Connect ${pairing.input.label} so Chopin can run work for you on it.`
				: "Chopin runs work for you on the machines you connect."}
			title={url ? "Machine connected" : "Connect this machine?"}
		>
			{error && <p className="m-0 text-sm text-destructive-ink" role="alert">{error}</p>}
			{pairing && (
				<div className="machines-card">
					<p className="machines-pairing-label">
						<MachineIcon aria-hidden="true" className="machines-entry-icon" size={18} />
						<span className="font-medium [overflow-wrap:anywhere]">{pairing.input.label}</span>
						{repository && <span className="text-text-secondary">{repository}</span>}
					</p>
					{url
						? (
							<>
								<p className="m-0" role="status">Connected.</p>
								<a className="btn btn-md btn-primary self-start" href={url}>
									{repository ? `Open ${repository}` : "Open Chopin"}
								</a>
							</>
						)
						: (
							<>
								<p className="m-0 text-text-secondary">
									Check that your terminal shows{" "}
									<code className="machines-code">{pairing.code}</code>
								</p>
								<label className="flex items-start gap-2">
									<input
										checked={autoRun}
										className="choice-control mt-0.5 size-4 shrink-0"
										disabled={busy}
										onChange={event => setAutoRun(event.target.checked)}
										type="checkbox"
									/>
									<span>Let Chopin build and prototype automatically on this machine</span>
								</label>
								<button
									className="btn btn-md btn-primary self-start"
									disabled={busy}
									onClick={() => void connect()}
									type="button"
								>
									Connect
								</button>
							</>
						)}
				</div>
			)}
			{url && <ConnectedMachines />}
		</MachinesFrame>
	);
}
