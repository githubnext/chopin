import { useCallback, useEffect, useRef, useState } from "react";

import {
	awaitingRetry,
	emptyResyncQueue,
	planDecisionWatch,
	requestResync,
	retryDecisionWatch,
	retryDelay,
	settleDecisionWatch,
	takeResyncs,
} from "./sidebar-decision-watch";
import { Wire } from "./wire";

import type { Sidebar } from "@chopin/protocol";
import type { ResyncQueue, WatchLedger } from "./sidebar-decision-watch";

type Handlers = {
	onCounts: (counts: Sidebar.Decisions) => void;
	onSnapshot: (snapshot: Sidebar.Snapshot) => void;
};

/**
 * Keep the Projects sidebar's decision counts live through its own socket, whether or
 * not a document is open, watching every repository the sidebar shows. Returns a
 * function that asks for a fresh snapshot of a repository whose total conflicts.
 */
export function useSidebarDecisions(
	repositories: Sidebar.WatchedRepository[],
	handlers: Handlers,
): (repositoryId: string) => void {
	let [wire, setWire] = useState<Wire>();
	let [connection, setConnection] = useState(0);
	let [retry, setRetry] = useState(0);
	let latestHandlers = useRef(handlers);
	latestHandlers.current = handlers;
	let latestRepositories = useRef(repositories);
	latestRepositories.current = repositories;
	let latestWire = useRef<Wire | undefined>(undefined);
	latestWire.current = wire;
	let ledger = useRef<WatchLedger>(new Map());
	let generation = useRef(0);
	let retryAttempts = useRef(0);
	let retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let resyncs = useRef<ResyncQueue>(emptyResyncQueue());
	let resyncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		let socket = new Wire({
			sidebar: true,
			onStatus: status => {
				generation.current++;
				ledger.current = new Map();
				resyncs.current = emptyResyncQueue();
				clearTimeout(retryTimer.current);
				retryTimer.current = undefined;
				clearTimeout(resyncTimer.current);
				resyncTimer.current = undefined;
				if (status === "connected") setConnection(current => current + 1);
			},
		});
		let unsubscribe = [
			socket.on<Sidebar.Decisions>("sidebar:decisions", frame => {
				latestHandlers.current.onCounts(frame);
			}),
			socket.on<Sidebar.Snapshot>("sidebar:snapshot", frame => {
				latestHandlers.current.onSnapshot(frame);
			}),
		];
		setWire(socket);
		return () => {
			for (let stop of unsubscribe) stop();
			clearTimeout(retryTimer.current);
			retryTimer.current = undefined;
			clearTimeout(resyncTimer.current);
			resyncTimer.current = undefined;
			socket.dispose();
			setWire(undefined);
		};
	}, []);

	useEffect(() => {
		if (!wire?.connected) return;
		let plan = planDecisionWatch(ledger.current, repositories);
		ledger.current = plan.ledger;
		let sentIn = generation.current;
		for (let repositoryIds of plan.unwatch) wire.send("sidebar:unwatch", { repositoryIds });
		for (let frame of plan.frames) {
			wire.ask<Sidebar.Watched>("sidebar:watch", { repositories: frame.repositories })
				.catch(() => undefined)
				.then(reply => {
					if (generation.current !== sentIn) return;
					ledger.current = settleDecisionWatch(ledger.current, frame, reply);
					if (!awaitingRetry(ledger.current)) {
						retryAttempts.current = 0;
						return;
					}
					if (retryTimer.current) return;
					retryTimer.current = setTimeout(() => {
						retryTimer.current = undefined;
						if (generation.current !== sentIn) return;
						ledger.current = retryDecisionWatch(ledger.current);
						setRetry(current => current + 1);
					}, retryDelay(retryAttempts.current++));
				});
		}
	}, [connection, repositories, retry, wire]);

	let flushResyncs = useCallback(() => {
		let socket = latestWire.current;
		if (!socket?.connected) return;
		let plan = takeResyncs(
			resyncs.current,
			ledger.current,
			latestRepositories.current,
			Date.now(),
		);
		resyncs.current = plan.queue;
		// The watch reply needs no settling: the ledger already holds these repositories.
		for (let repositories of plan.frames) {
			socket.ask<Sidebar.Watched>("sidebar:watch", { repositories }).catch(() => undefined);
		}
		if (plan.wait === undefined || resyncTimer.current) return;
		resyncTimer.current = setTimeout(() => {
			resyncTimer.current = undefined;
			flushResyncs();
		}, plan.wait);
	}, []);

	return useCallback((repositoryId: string) => {
		resyncs.current = requestResync(resyncs.current, repositoryId);
		flushResyncs();
	}, [flushResyncs]);
}
