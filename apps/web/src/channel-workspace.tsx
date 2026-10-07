import { useEffect, useState } from "react";

import { readChannelRecovery, rememberChannel } from "./channel-recovery";
import { newestDocument } from "./document-actions";
import { documentRouteIdentity } from "./document-route-swap";
import { useNavigationDocument } from "./navigation-shell";

import type { ComponentType } from "react";
import type * as Api from "./api";
import type { DocumentRouteIdentity } from "./document-route-swap";
import type {
	ChannelSource,
	DocumentRouteResolution,
	HostedFailure,
	HostedLoading,
	HostedWorkspaceProps,
} from "./hosted";

export default function ChannelWorkspace(
	{ agent, Failure, Loading, onReady, retryable, source, user }: {
		agent: boolean;
		Failure: typeof HostedFailure;
		Loading: typeof HostedLoading;
		onReady?: (key: DocumentRouteIdentity, resolution?: DocumentRouteResolution) => void;
		retryable: (error: unknown) => boolean;
		source: ChannelSource;
		user: Api.User;
	},
) {
	type LoadedWorkspace = {
		detail: Api.ChannelDetail;
		Workspace: ComponentType<HostedWorkspaceProps>;
	};
	let [loaded, setLoaded] = useState<LoadedWorkspace>();
	let [error, setError] = useState<unknown>();
	let [retry, setRetry] = useState(0);
	let { channel: navigationChannel } = useNavigationDocument();
	let routeKey = documentRouteIdentity(source);
	let recovery = readChannelRecovery(user.id, source.id);

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		setLoaded(undefined);
		setError(undefined);
		let prepared = import("./document-loader").then(module =>
			module.prepareDocumentLoad({ id: source.id }, controller.signal)
		).then(({ detail, pathname }) => ({ canonicalPath: pathname, detail }));
		prepared = prepared.then(resolved => {
			if (active) {
				rememberChannel(user.id, resolved.detail.channel, resolved.detail.repository);
			}
			return resolved;
		});
		let workspace = import("./room-workspace").then(module => ({
			Workspace: module.RoomWorkspace,
		}));
		Promise.all([prepared, workspace]).then(([resolved, selected]) => {
			if (active) {
				setLoaded({ detail: resolved.detail, ...selected });
				onReady?.(routeKey, {
					canonicalPath: resolved.canonicalPath,
					channel: resolved.detail.channel,
					routeKey,
				});
			}
		}, reason => {
			if (active) {
				setError(reason);
				onReady?.(routeKey);
			}
		});
		return () => {
			active = false;
			controller.abort();
		};
	}, [onReady, retry, routeKey, source, user.id]);
	if (error) {
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
	if (!loaded) return <Loading label="Opening document…" />;
	let { detail } = loaded;
	let channel = navigationChannel?.id === detail.channel.id
		? newestDocument(detail.channel, navigationChannel)
		: detail.channel;
	let props: HostedWorkspaceProps = {
		agent,
		archivedAt: channel.archivedAt,
		canEdit: !channel.archivedAt && (detail.canEdit || detail.canManage),
		canManage: detail.canManage,
		description: channel.description,
		descriptionRevision: channel.descriptionRevision,
		handle: user.login,
		label: channel.title,
		presentation: { type: "document" },
		slug: channel.slug,
		updatedAt: channel.updatedAt,
		repository: detail.repository,
		room: detail.channel.id,
		userId: user.id,
	};
	let Document = loaded.Workspace;
	return <Document {...props} />;
}
