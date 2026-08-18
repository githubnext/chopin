import { describe, expect, it } from "bun:test";

import { currentViewport, listenToViewportChanges } from "./viewport";

import type { ViewportEventTarget, ViewportSource } from "./viewport";

class FakeTarget extends EventTarget implements ViewportEventTarget {
	readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: AddEventListenerOptions | boolean,
	): void {
		super.addEventListener(type, listener, options);
		if (!listener) return;
		let listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: EventListenerOptions | boolean,
	): void {
		super.removeEventListener(type, listener, options);
		if (!listener) return;
		this.listeners.get(type)?.delete(listener);
	}

	fire(type: string): void {
		this.dispatchEvent(new Event(type));
	}

	count(): number {
		return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
	}
}

function source(
	visualViewport?: ViewportSource["visualViewport"],
): ViewportSource & { document: FakeTarget; window: FakeTarget } {
	return {
		document: new FakeTarget(),
		innerHeight: 844,
		innerWidth: 390,
		visualViewport,
		window: new FakeTarget(),
	};
}

describe("current viewport", () => {
	it("uses the offset and size of the visual viewport", () => {
		let visual = Object.assign(new FakeTarget(), {
			height: 506,
			offsetLeft: 12,
			offsetTop: 22,
			width: 320,
		});

		expect(currentViewport(source(visual))).toEqual({
			height: 506,
			left: 12,
			top: 22,
			width: 320,
		});
	});

	it("falls back to the layout viewport", () => {
		expect(currentViewport(source())).toEqual({
			height: 844,
			left: 0,
			top: 0,
			width: 390,
		});
	});
});

describe("viewport changes", () => {
	it("reports every configured browser geometry event", () => {
		let visual = Object.assign(new FakeTarget(), {
			height: 506,
			offsetLeft: 0,
			offsetTop: 0,
			width: 390,
		});
		let browser = source(visual);
		let scroller = new FakeTarget();
		let changes = 0;
		listenToViewportChanges(() => changes++, {
			observeDocumentScroll: true,
			scrollTargets: [scroller],
			source: browser,
		});

		browser.window.fire("resize");
		expect(changes).toBe(1);
		visual.fire("resize");
		expect(changes).toBe(2);
		visual.fire("scroll");
		expect(changes).toBe(3);
		browser.document.fire("scroll");
		expect(changes).toBe(4);
		scroller.fire("scroll");
		expect(changes).toBe(5);
	});

	it("does not report document scroll unless configured", () => {
		let browser = source();
		let changes = 0;
		listenToViewportChanges(() => changes++, { source: browser });

		browser.document.fire("scroll");

		expect(changes).toBe(0);
	});

	it("cleanup removes every registered listener", () => {
		let visual = Object.assign(new FakeTarget(), {
			height: 506,
			offsetLeft: 0,
			offsetTop: 0,
			width: 390,
		});
		let browser = source(visual);
		let firstScroller = new FakeTarget();
		let secondScroller = new FakeTarget();
		let changes = 0;
		let cleanup = listenToViewportChanges(() => changes++, {
			observeDocumentScroll: true,
			scrollTargets: [firstScroller, secondScroller],
			source: browser,
		});

		cleanup();

		expect(browser.window.count()).toBe(0);
		expect(browser.document.count()).toBe(0);
		expect(visual.count()).toBe(0);
		expect(firstScroller.count()).toBe(0);
		expect(secondScroller.count()).toBe(0);
		browser.window.fire("resize");
		browser.document.fire("scroll");
		visual.fire("resize");
		visual.fire("scroll");
		firstScroller.fire("scroll");
		secondScroller.fire("scroll");
		expect(changes).toBe(0);
	});
});
