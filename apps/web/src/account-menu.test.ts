import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountMenu, SidebarAccount } from "./account-menu";

let menu = {
	className: "is-open",
	closing: false,
	onDismiss() {},
	onShortcuts() {},
	onSignOut() {},
};
let user = { avatarUrl: "", id: "user-one", login: "MaggieAppleton" };

describe("the account menu", () => {
	test("hides and disables a closing menu", () => {
		let open = renderToStaticMarkup(createElement(AccountMenu, { id: "account", menu }));
		let closing = renderToStaticMarkup(createElement(AccountMenu, {
			id: "account",
			menu: { ...menu, className: "is-closing", closing: true },
		}));

		expect(open).toContain('class="navigation-account-menu motion-dropdown is-open"');
		expect(open).not.toMatch(/^<div aria-hidden/);
		expect(closing).toMatch(/^<div aria-hidden="true"/);
		expect(closing).toContain("inert");
	});

	test("controls the menu only while it is shown", () => {
		let closed = renderToStaticMarkup(createElement(SidebarAccount, {
			menuId: "account",
			onAccount() {},
			user,
		}));
		let open = renderToStaticMarkup(createElement(SidebarAccount, {
			menu,
			menuId: "account",
			onAccount() {},
			user,
		}));

		expect(closed).not.toContain("aria-controls");
		expect(closed).not.toContain('role="menu"');
		expect(open).toContain('aria-controls="account"');
		expect(open).toContain('aria-expanded="true"');
		expect(open).toContain('id="account" role="menu"');
	});
});
