import { loadLocalEnv } from "./load-env";
import { ensureSchema } from "@/lib/db";

loadLocalEnv();

await ensureSchema();
console.log("Database migrations applied.");
