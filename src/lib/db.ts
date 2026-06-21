import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { MIGRATIONS } from "@/lib/migration-files";

let pool: Pool | undefined;
let schemaReady: Promise<void> | undefined;
const MIGRATIONS_TABLE = "meshaction_schema_migrations";

function databaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("DATABASE_URL is required");
  }
  return value;
}

export function getPool() {
  pool ??= new Pool({
    connectionString: databaseUrl(),
    max: Number(process.env.DATABASE_POOL_MAX ?? 8),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 5000),
    query_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS ?? 15000),
    statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 15000),
  });
  return pool;
}

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = runMigrations();
  }

  try {
    return await schemaReady;
  } catch (error) {
    schemaReady = undefined;
    throw error;
  }
}

async function runMigrations() {
  const db = getPool();
  await db.query(`
    create table if not exists ${MIGRATIONS_TABLE} (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const appliedResult = await db.query<{ filename: string }>(
    `select filename from ${MIGRATIONS_TABLE}`
  );
  const applied = new Set(appliedResult.rows.map((row) => row.filename));

  for (const migration of MIGRATIONS) {
    const { filename, sql } = migration;
    if (applied.has(filename)) {
      continue;
    }
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        `insert into ${MIGRATIONS_TABLE} (filename) values ($1)`,
        [filename]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<QueryResult<T>> {
  await ensureSchema();
  return getPool().query<T>(text, values);
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
