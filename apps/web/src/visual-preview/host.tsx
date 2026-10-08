import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { acceptFrameMessage, sameValues, valuesValid } from "./protocol";
import { PreviewUnavailable, verifiedPreview } from "./verify";

import type { Envelope } from "./protocol";
import type { VisualDecision } from "@chopin/protocol";

export type PreviewStatus = "loading" | "ready" | "unavailable" | "error";
type Props = {
	channelId: string;
	decisionId: string;
	definition: VisualDecision.Definition;
	values: VisualDecision.Values;
	onStatus: (status: PreviewStatus) => void;
};

const ACK_MS = 2_000;
const FETCH_MS = 8_000;
const RETRIES = 2;

export function VisualPreview({ channelId, decisionId, definition, values, onStatus }: Props) {
	let [url, setUrl] = useState<string>();
	let [status, setStatus] = useState<PreviewStatus>("loading");
	let [error, setError] = useState<string>();
	let [attempt, setAttempt] = useState(0);
	let [cycle, setCycle] = useState(0);
	let [height, setHeight] = useState(380);
	let generation =
		`${channelId}:${decisionId}:${definition.definitionRevision}:${definition.artifact.ref}:${definition.artifact.digest}`;
	let generationRef = useRef(generation);
	generationRef.current = generation;
	let frame = useRef<HTMLIFrameElement>(null);
	let sendSet = useRef<((next: VisualDecision.Values) => void) | undefined>(undefined);
	let desired = useRef(values);
	let state = useRef<
		| (Envelope & { confirmed: boolean; ackRevision: number; controls: VisualDecision.Control[] })
		| undefined
	>(undefined);
	desired.current = values;

	useEffect(() => {
		let current = state.current;
		let acknowledged = current?.ackRevision === current?.revision
			&& current?.definitionRevision === definition.definitionRevision
			&& sameValues(current.values, values);
		onStatus(status === "ready" && !acknowledged ? "loading" : status);
	}, [definition.definitionRevision, onStatus, status, values]);
	useLayoutEffect(() => {
		state.current = undefined;
		setStatus("loading");
	}, [generation]);

	useEffect(() => {
		let abort = new AbortController();
		let active = true;
		let timeout = setTimeout(() => abort.abort(), FETCH_MS);
		state.current = undefined;
		setUrl(undefined);
		setError(undefined);
		setAttempt(0);
		setStatus("loading");
		void verifiedPreview(channelId, decisionId, definition, abort.signal).then(verified => {
			if (active && generationRef.current === generation && !abort.signal.aborted) {
				setUrl(verified);
			}
		}).catch(failure => {
			if (!active || generationRef.current !== generation) return;
			setStatus(failure instanceof PreviewUnavailable ? "unavailable" : "error");
			setError(
				failure instanceof PreviewUnavailable
					? failure.message
					: abort.signal.aborted
					? "Preview timed out"
					: "Preview could not be verified",
			);
		}).finally(() => clearTimeout(timeout));
		return () => {
			active = false;
			abort.abort();
			clearTimeout(timeout);
		};
	}, [
		channelId,
		decisionId,
		definition.definitionRevision,
		definition.artifact.ref,
		definition.artifact.digest,
		cycle,
	]);

	useEffect(() => {
		let element = frame.current;
		if (!url || !element || error) return;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		state.current = undefined;
		setStatus("loading");
		function fail() {
			if (generationRef.current !== generation) return;
			state.current = undefined;
			if (attempt < RETRIES) setAttempt(attempt + 1);
			else {
				setStatus("error");
				setError("Preview could not reconnect. Retry to reload it.");
			}
		}
		function arm() {
			clearTimeout(timeout);
			timeout = setTimeout(fail, ACK_MS);
		}
		function send(envelope: Envelope, type: "init" | "set") {
			let message = type === "init"
				? { ...envelope, type, controls: definition.controls, baseline: definition.baseline }
				: { ...envelope, type };
			element?.contentWindow?.postMessage(message, "*");
			arm();
		}
		sendSet.current = next => {
			if (generationRef.current !== generation) return;
			let current = state.current;
			if (!current?.confirmed || sameValues(current.values, next)) return;
			if (!valuesValid(definition.controls, next)) {
				setStatus("error");
				setError("Preview values are invalid");
				return;
			}
			current.values = { ...next };
			current.revision++;
			let {
				confirmed: _confirmed,
				ackRevision: _ackRevision,
				controls: _controls,
				...envelope
			} = current;
			send(envelope, "set");
			setStatus("loading");
		};
		function load() {
			if (generationRef.current !== generation) return;
			if (!valuesValid(definition.controls, desired.current)) {
				setStatus("error");
				setError("Preview values are invalid");
				return;
			}
			let envelope: Envelope = {
				version: 1,
				session: crypto.randomUUID().replaceAll("-", ""),
				revision: 0,
				definitionRevision: definition.definitionRevision,
				values: { ...desired.current },
			};
			state.current = {
				...envelope,
				confirmed: false,
				ackRevision: -1,
				controls: definition.controls,
			};
			send(envelope, "init");
		}
		function message(event: MessageEvent) {
			if (generationRef.current !== generation) return;
			let current = state.current;
			if (!current || !element) return;
			let reply = acceptFrameMessage(event, { ...current, source: element.contentWindow });
			if (!reply) return;
			if (reply.type === "error") {
				clearTimeout(timeout);
				fail();
				return;
			}
			if (reply.type === "size" && current.confirmed) {
				setHeight(Math.max(300, Math.min(640, reply.height)));
				return;
			}
			if (
				(reply.type !== "ready" || current.confirmed)
				&& (reply.type !== "ack" || !current.confirmed)
			) return;
			clearTimeout(timeout);
			current.confirmed = true;
			current.ackRevision = reply.revision;
			if (!valuesValid(definition.controls, desired.current)) {
				setStatus("error");
				setError("Preview values are invalid");
				return;
			}
			if (!sameValues(current.values, desired.current)) {
				sendSet.current?.(desired.current);
			} else setStatus("ready");
		}
		element.addEventListener("load", load);
		window.addEventListener("message", message);
		arm();
		element.src = url;
		return () => {
			clearTimeout(timeout);
			sendSet.current = undefined;
			state.current = undefined;
			element.removeEventListener("load", load);
			window.removeEventListener("message", message);
		};
	}, [url, attempt, error, generation]);

	useLayoutEffect(() => {
		let current = state.current;
		if (!current?.confirmed || sameValues(current.values, values)) return;
		sendSet.current?.(values);
	}, [values, definition.controls]);

	return (
		<div className="relative min-w-0" data-visual-preview-state={status}>
			{url && !error && (
				<iframe
					key={`${cycle}:${attempt}`}
					ref={frame}
					title={`${definition.title} preview`}
					sandbox="allow-scripts"
					referrerPolicy="no-referrer"
					className={`w-full border-0 ${status === "ready" ? "opacity-100" : "opacity-0"}`}
					style={{ height }}
				/>
			)}
			{status === "loading" && (
				<p role="status" className="m-0 text-sm text-text-tertiary">Loading preview…</p>
			)}
			{error && (
				<div role="alert" className="flex flex-col items-start gap-2 text-sm text-text-secondary">
					<p className="m-0">{error}</p>
					<button
						type="button"
						className="btn-outline btn-sm"
						onClick={() =>
							setCycle(previous =>
								previous + 1
							)}
					>
						Retry preview
					</button>
				</div>
			)}
		</div>
	);
}
