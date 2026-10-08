import { useEffect, useRef, useState } from "react";
import { acceptFrameMessage, sameValues } from "./protocol";
import { verifiedPreview } from "./verify";

import type { Envelope } from "./protocol";
import type { VisualDecision } from "@chopin/protocol";

type Props = { definition: VisualDecision.Definition; values: VisualDecision.Values };
const HANDSHAKE_MS = 1_500;

export function VisualPreview({ definition, values }: Props) {
	let [url, setUrl] = useState<string>();
	let [error, setError] = useState<string>();
	let [attempt, setAttempt] = useState(0);
	let [cycle, setCycle] = useState(0);
	let [ready, setReady] = useState(false);
	let [height, setHeight] = useState(380);
	let frame = useRef<HTMLIFrameElement>(null);
	let desired = useRef(values);
	let state = useRef<(Envelope & { ready: boolean }) | undefined>(undefined);
	desired.current = values;

	useEffect(() => {
		let abort = new AbortController();
		setUrl(undefined);
		setError(undefined);
		setAttempt(0);
		void verifiedPreview(definition, abort.signal).then(verified => {
			if (!abort.signal.aborted) setUrl(verified);
		}).catch(failure => {
			if (!abort.signal.aborted) {
				setError(failure instanceof Error ? failure.message : "Preview unavailable");
			}
		});
		return () => abort.abort();
	}, [definition.bundleDigest, cycle]);

	useEffect(() => {
		let element = frame.current;
		if (!url || !element) return;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		state.current = undefined;
		setReady(false);
		function failed() {
			state.current = undefined;
			if (attempt < 2) setAttempt(attempt + 1);
			else setError("Preview could not reconnect. Retry to reload it.");
		}
		function load() {
			clearTimeout(timeout);
			setReady(false);
			let envelope: Envelope = {
				version: 1,
				session: crypto.randomUUID().replaceAll("-", ""),
				revision: 0,
				values: { ...desired.current },
			};
			state.current = { ...envelope, ready: false };
			timeout = setTimeout(failed, HANDSHAKE_MS);
			element?.contentWindow?.postMessage({ ...envelope, type: "init" }, "*");
		}
		function message(event: MessageEvent) {
			let current = state.current;
			if (!current || !element) return;
			let reply = acceptFrameMessage(event, { ...current, source: element.contentWindow });
			if (!reply) return;
			if (reply.type === "ready" && !current.ready) {
				clearTimeout(timeout);
				current.ready = true;
				setReady(true);
				if (!sameValues(current.values, desired.current)) {
					current.values = { ...desired.current };
					current.revision++;
					let { ready: _ready, ...envelope } = current;
					element.contentWindow?.postMessage({ ...envelope, type: "set" }, "*");
				}
			} else if (reply.type === "size" && current.ready) {
				setHeight(Math.max(300, Math.min(640, reply.height)));
			}
		}
		element.addEventListener("load", load);
		window.addEventListener("message", message);
		timeout = setTimeout(failed, HANDSHAKE_MS);
		element.src = url;
		return () => {
			clearTimeout(timeout);
			state.current = undefined;
			element.removeEventListener("load", load);
			window.removeEventListener("message", message);
		};
	}, [url, attempt]);

	useEffect(() => {
		let current = state.current;
		if (!current?.ready || sameValues(current.values, values)) return;
		current.values = { ...values };
		current.revision++;
		let { ready: _ready, ...envelope } = current;
		frame.current?.contentWindow?.postMessage({ ...envelope, type: "set" }, "*");
	}, [values]);

	return (
		<div
			className="relative min-w-0"
			data-visual-preview-state={error ? "failed" : ready ? "ready" : "loading"}
		>
			{url && !error && (
				<iframe
					key={`${cycle}:${attempt}`}
					ref={frame}
					title="Adjusted decision card"
					sandbox="allow-scripts"
					referrerPolicy="no-referrer"
					className={`w-full border-0 ${ready ? "opacity-100" : "opacity-0"}`}
					style={{ height }}
				/>
			)}
			{!ready && !error && (
				<p role="status" className="m-0 text-sm text-text-tertiary">Loading preview…</p>
			)}
			{error && (
				<div role="alert" className="flex flex-col items-start gap-2 text-sm text-text-secondary">
					<p className="m-0">{error}</p>
					<button
						type="button"
						className="btn-outline btn-sm"
						onClick={() => {
							setCycle(previous =>
								previous + 1
							);
						}}
					>
						Retry preview
					</button>
				</div>
			)}
		</div>
	);
}
