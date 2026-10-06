import { SQL } from "bun";

export async function writerLease() {
	let database = new SQL(process.env.E2E_DATABASE_URL_0!);
	try {
		let [lease] =
			await database`SELECT owner, fencing FROM storage_leases WHERE name = 'chopin:writer'`;
		return lease;
	} finally {
		await database.close();
	}
}
