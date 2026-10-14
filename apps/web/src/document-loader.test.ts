import { describe, expect, it } from "bun:test";

import { ApiError } from "./api";
import { prepareDocumentLoad } from "./document-loader";

import type { ChannelDetail } from "./api";

function detail(id: string, slug: string, parentChannelId?: string): ChannelDetail {
	return {
		canEdit: true,
		canManage: true,
		channel: {
			createdAt: "2026-08-24T00:00:00.000Z",
			createdBy: "user-one",
			descriptionRevision: 0,
			id,
			...(parentChannelId ? { parentChannelId } : {}),
			repositoryId: "R_score",
			repositoryName: "score",
			repositoryOwner: "octo-org",
			revision: 0,
			slug,
			title: slug,
			updatedAt: "2026-08-24T00:00:00.000Z",
		},
		repository: {
			defaultBranch: "main",
			fullName: "octo-org/score",
			id: "R_score",
			name: "score",
			owner: "octo-org",
			permissions: { admin: false, pull: true, push: true },
			private: false,
			url: "https://github.com/octo-org/score",
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	let promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, reject, resolve };
}

let address = {
	owner: "octo-org",
	parentSlug: "release-plan",
	repository: "score",
	slug: "source-review",
};

describe("direct child document load", () => {
	it("starts both reads and publishes its single fresh parent before the child resolves", async () => {
		let parent = detail("parent-one", address.parentSlug);
		let child = detail("child-one", address.slug, parent.channel.id);
		let parentRead = deferred<ChannelDetail>();
		let childRead = deferred<ChannelDetail>();
		let calls: string[] = [];
		let published: ChannelDetail[] = [];
		let parentPublished = deferred<ChannelDetail>();
		let signal = new AbortController().signal;
		let readers = {
			channel: async () => {
				throw new Error("unexpected ID read");
			},
			document: async (
				_owner: string,
				_repository: string,
				slug: string,
				received?: AbortSignal,
			) => {
				expect(received).toBe(signal);
				calls.push(slug);
				return slug === address.parentSlug ? parentRead.promise : childRead.promise;
			},
		};
		let pending = prepareDocumentLoad(address, signal, readers, detail => {
			published.push(detail);
			parentPublished.resolve(detail);
		});
		expect(calls).toEqual([address.slug, address.parentSlug]);
		parentRead.resolve(parent);
		await parentPublished.promise;
		expect(published).toEqual([parent]);
		childRead.resolve(child);
		expect(await pending).toEqual({
			detail: child,
			parent,
			pathname: "/documents/octo-org/score/release-plan/children/source-review",
		});
		expect(calls).toHaveLength(2);
	});

	it("still publishes the parent when the child fails first, then reports that failure", async () => {
		let parent = detail("parent-one", address.parentSlug);
		let parentRead = deferred<ChannelDetail>();
		let childRead = deferred<ChannelDetail>();
		let published: ChannelDetail[] = [];
		let failure = new ApiError("Child temporarily unavailable", 503);
		let pending = prepareDocumentLoad(address, new AbortController().signal, {
			channel: async () => {
				throw new Error("unexpected ID read");
			},
			document: async (_owner, _repository, slug) =>
				slug === address.parentSlug ? parentRead.promise : childRead.promise,
		}, detail => published.push(detail));
		childRead.reject(failure);
		parentRead.resolve(parent);
		await expect(pending).rejects.toBe(failure);
		expect(published).toEqual([parent]);
	});

	it("validates the child against exactly the published parent", async () => {
		let parent = detail("parent-one", address.parentSlug);
		let child = detail("child-one", address.slug, "different-parent");
		let published: ChannelDetail[] = [];
		await expect(prepareDocumentLoad(address, new AbortController().signal, {
			channel: async () => {
				throw new Error("unexpected ID read");
			},
			document: async (_owner, _repository, slug) => slug === address.parentSlug ? parent : child,
		}, detail => published.push(detail))).rejects.toMatchObject({ status: 404 });
		expect(published).toEqual([parent]);
	});

	it("does not publish a parent from an aborted request", async () => {
		let parent = detail("parent-one", address.parentSlug);
		let controller = new AbortController();
		let published: ChannelDetail[] = [];
		let pending = prepareDocumentLoad(address, controller.signal, {
			channel: async () => {
				throw new Error("unexpected ID read");
			},
			document: async (_owner, _repository, slug, signal) => {
				if (slug === address.parentSlug) {
					return new Promise<ChannelDetail>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("aborted")));
					});
				}
				return detail("child-one", address.slug, parent.channel.id);
			},
		}, detail => published.push(detail));
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		expect(published).toEqual([]);
	});
});
