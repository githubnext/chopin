import { useCallback, useEffect, useRef, useState } from "react";
import { documentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import { documentRouteIdentity } from "./document-route-swap";
import { canManageProject } from "./navigation-model";

export type DocumentCreationPhase = "creating" | "opening";

type Attempt = {
	phase: DocumentCreationPhase;
	destination?: string;
};

export function useDocumentCreation(
	{ routeKey, onCreated, onNavigate, onAccessChanged }: {
		routeKey: string;
		onCreated: (channel: Api.Channel) => void;
		onNavigate: (documentId: string, path: string) => void;
		onAccessChanged: () => void;
	},
) {
	let attempts = useRef(new Map<string, Attempt>());
	let [pending, setPending] = useState<ReadonlyMap<string, DocumentCreationPhase>>(() => new Map());
	let [error, setError] = useState<{ project: Api.NavigationProject; message: string }>();
	let latest = useRef<Attempt | undefined>(undefined);
	let location = useRef({ routeKey });
	if (location.current.routeKey !== routeKey) location.current = { routeKey };
	let publish = useCallback(() => {
		setPending(new Map([...attempts.current].map(([id, attempt]) => [id, attempt.phase])));
	}, []);
	let finish = useCallback((projectId: string, attempt: Attempt) => {
		if (attempts.current.get(projectId) !== attempt) return;
		attempts.current.delete(projectId);
		publish();
	}, [publish]);

	useEffect(() => () => {
		latest.current = undefined;
		location.current = { routeKey: "" };
	}, []);

	useEffect(() => {
		for (let [id, attempt] of attempts.current) {
			if (attempt.phase === "opening" && attempt.destination !== routeKey) finish(id, attempt);
		}
		setError(undefined);
	}, [finish, routeKey]);

	let settled = useCallback((key: string) => {
		if (location.current.routeKey !== key) return;
		for (let [id, attempt] of attempts.current) {
			if (attempt.phase === "opening" && attempt.destination === key) finish(id, attempt);
		}
	}, [finish]);

	let create = async (project: Api.NavigationProject) => {
		let id = project.repositoryId;
		if (!project.available || !canManageProject(project) || attempts.current.has(id)) return;
		let attempt: Attempt = { phase: "creating" };
		let origin = location.current;
		attempts.current.set(id, attempt);
		latest.current = attempt;
		setError(undefined);
		publish();
		try {
			let created = await Api.createChannel(project.repositoryOwner, project.repositoryName);
			onCreated(created.channel);
			// A successful POST still belongs in the catalogue after the user moves on.
			if (location.current !== origin || latest.current !== attempt) {
				finish(id, attempt);
				return;
			}
			attempt.phase = "opening";
			attempt.destination = documentRouteIdentity({
				page: "document",
				owner: created.repository.owner,
				repository: created.repository.name,
				slug: created.channel.slug,
			});
			publish();
			onNavigate(
				created.channel.id,
				documentPath(
					created.repository.owner,
					created.repository.name,
					created.channel.slug,
				),
			);
		} catch (reason) {
			finish(id, attempt);
			if (location.current === origin && latest.current === attempt) {
				setError({
					project,
					message: reason instanceof Error ? reason.message : "Could not create document.",
				});
			}
			if (reason instanceof Api.ApiError && reason.status === 403) onAccessChanged();
		}
	};
	return { create, error, pending, settled };
}
