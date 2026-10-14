import { useEffect, useRef, useState } from "react";

import { AgendaError, request } from "./client";

import type { Agenda } from "@chopin/protocol";

/** An open dialog observes durable HTTP state; it never starts work by observing it. */
export function useAgenda(channelId: string, active: boolean) {
	let [snapshot, setSnapshot] = useState<Agenda.Response>();
	let [error, setError] = useState<AgendaError>();
	let [busy, setBusy] = useState(false);
	let [retry, setRetry] = useState(0);
	let sequence = useRef(0);
	let controller = useRef<AbortController>(undefined);
	let available = useRef(active);
	let writing = useRef(false);

	useEffect(() => {
		available.current = active;
		if (!active) return;
		setBusy(false);
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			if (stopped) return;
			if (!writing.current) {
				let token = ++sequence.current;
				let abort = new AbortController();
				controller.current?.abort();
				controller.current = abort;
				try {
					let next = await request(channelId, "load", undefined, abort.signal);
					if (!stopped && token === sequence.current) {
						setSnapshot(next);
						setError(current => current?.status === 409 ? current : undefined);
					}
				} catch (reason) {
					if (!stopped && token === sequence.current && !abort.signal.aborted) {
						setError(reason instanceof AgendaError ? reason : new AgendaError(0));
					}
				}
			}
			if (!stopped) timer = setTimeout(poll, 5000);
		}
		void poll();
		return () => {
			stopped = true;
			available.current = false;
			++sequence.current;
			clearTimeout(timer);
			controller.current?.abort();
		};
	}, [active, channelId, retry]);

	async function mutate(
		action: "save" | "activate" | "pause",
		input: Agenda.Save | Agenda.Pause | { expectedRevision: number },
	): Promise<Agenda.Response | undefined> {
		if (writing.current || !available.current) return;
		writing.current = true;
		setBusy(true);
		setError(undefined);
		let token = ++sequence.current;
		controller.current?.abort();
		let abort = new AbortController();
		controller.current = abort;
		try {
			let next = await request(channelId, action, input, abort.signal);
			if (available.current && token === sequence.current) {
				setSnapshot(next);
				return next;
			}
		} catch (reason) {
			if (available.current && token === sequence.current && !abort.signal.aborted) {
				let failure = reason instanceof AgendaError ? reason : new AgendaError(0);
				setError(failure);
				if (failure.status === 409) {
					try {
						let latest = await request(channelId, "load", undefined, abort.signal);
						if (available.current && token === sequence.current) setSnapshot(latest);
					} catch {
						// The conflict remains visible; reopening or retrying can recover a lost connection.
					}
				}
			}
		} finally {
			writing.current = false;
			if (available.current) setBusy(false);
		}
	}
	return {
		snapshot,
		error,
		busy,
		mutate,
		reload() {
			setError(undefined);
			setBusy(false);
			setRetry(value => value + 1);
		},
	};
}
