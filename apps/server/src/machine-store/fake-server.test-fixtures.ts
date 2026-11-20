import { databasesNamed, MachineStoreRefusal } from "./server";

import type { MachineStoreServer } from "./server";

export class FakeMachineStoreServer implements MachineStoreServer {
	passwords = new Map<string, string>();
	enabled = new Set<string>();
	dropped = new Set<string>();
	calls: string[] = [];
	refuse?: string;
	failAfterApplying = false;
	unreachable = false;
	provisioning?: Promise<void>;
	/** The other databases each role has CONNECT on, as the catalog would say, whatever its login. */
	reaches = new Map<string, string[]>();
	/** The roles each catalog read asked about, and a hook run after each read. */
	read: string[][] = [];
	afterRead?: () => void;
	loginUrl(role: string) {
		return `postgresql://${role}@db.example.com:5432/${role}?sslmode=verify-full`;
	}
	async provision(role: string, password: string) {
		this.calls.push(`provision ${role}`);
		await this.provisioning;
		if (this.refuse) throw new MachineStoreRefusal(this.refuse);
		let open = this.reaches.get(role) ?? [];
		if (open.length) {
			throw new MachineStoreRefusal(
				`admin can't revoke CONNECT from PUBLIC on the ${databasesNamed(open)}`,
			);
		}
		this.passwords.set(role, password);
		this.enabled.add(role);
	}
	async setPassword(role: string, password: string) {
		this.calls.push(`password ${role}`);
		if (this.refuse) throw new MachineStoreRefusal(this.refuse);
		this.passwords.set(role, password);
		if (this.failAfterApplying) throw new MachineStoreRefusal("the connection dropped");
	}
	async accepts(role: string, password: string) {
		if (this.unreachable) return undefined;
		return this.enabled.has(role) && this.passwords.get(role) === password;
	}
	async reaching(roles: readonly string[]) {
		this.read.push([...roles]);
		let found = new Map<string, string[]>();
		if (this.unreachable) {
			throw new MachineStoreRefusal("Chopin couldn't reach the database server");
		}
		for (let role of roles) {
			let open = this.reaches.get(role) ?? [];
			if (this.enabled.has(role) && open.length) found.set(role, [...open]);
		}
		this.afterRead?.();
		return found;
	}
	async disable(role: string) {
		this.calls.push(`disable ${role}`);
		if (this.refuse) throw new MachineStoreRefusal(this.refuse);
		this.enabled.delete(role);
	}
	async drop(role: string) {
		this.calls.push(`drop ${role}`);
		this.dropped.add(role);
		this.passwords.delete(role);
	}
	async close() {}
}
