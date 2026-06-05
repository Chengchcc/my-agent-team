import { loadConfig } from "./config.js";
import { openDb } from "./infra/sqlite/db.js";

const config = loadConfig();
const db = openDb(`${config.dataDir}/backend.db`);

console.log(`[backend] dataDir=${config.dataDir}`);
console.log(`[backend] db ready, tables migrated`);

// TODO: server startup (commit 10)
db.close();
