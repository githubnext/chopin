import { useEffect, useState } from "react";

import { readChannelRecovery, rememberChannel } from "./channel-recovery";
import { documentRouteIdentity } from "./document-route-swap";

import type * as Api from "./api";
import type { DocumentRouteIdentity } from "./document-route-swap";
import type { ChannelSource, HostedFailure, HostedLoading } from "./hosted";

// Failure, Loading and retryable arrive as props rather than imports so this lazy chunk has
// no runtime import of hosted.tsx, which lazily imports it. A channel URL resolves to its
// document path before any workspace mounts, so the document host mounts once under its own
// route identity instead of replacing a channel-keyed room.
export default function ChannelWorkspace(
	{ Failure, Loading, onReady, onResolved, retryable, source, user }: {
		Failure: typeof HostedFailure;
		Loading: typeof HostedLoading;
		onReady: (key: DocumentRouteIdentity) => void;
		onResolved: (key: DocumentRouteIdentity, pathname: string) => void;
		retryable: (error: unknown) => boolean;
		source: ChannelSource;
		user: Api.User;
	},
) {
	let [error, setError] = useState<unknown>();
	let [retry, setRetry] = useState(0);
	let routeKey = documentRouteIdentity(source);
	let id = source.id;

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		setError(undefined);
		import("./document-loader").then(module =>
			module.prepareDocumentLoad({ id }, controller.signal)
		).then(({ detail, pathname }) => {
			if (!active) return;
			rememberChannel(user.id, detail.channel, detail.repository);
			onResolved(routeKey, pathname);
		}, reason => {
			if (!active) return;
			setError(reason);
			onReady(routeKey);
		});
		return () => {
			active = false;
			controller.abort();
		};
	}, [id, onReady, onResolved, retry, routeKey, user.id]);
	if (error) {
		let recovery = readChannelRecovery(user.id, id);
		return (
			<Failure
				channel={recovery?.channel}
				error={error}
				onRetry={retryable(error)
					? () => {
						setError(undefined);
						setRetry(value => value + 1);
					}
					: undefined}
				repository={recovery?.repository}
			/>
		);
	}
	return <Loading label="Opening document…" />;
}
