import { sentRequestsContract } from "../../ai/usage-contract";
import { PostgresStorage } from "./adapter";

let url = process.env.TEST_DATABASE_URL;

if (url) sentRequestsContract("postgres", () => new PostgresStorage(url));
