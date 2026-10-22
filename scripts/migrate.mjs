import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import "dotenv/config";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" || process.env.DATABASE_URL.includes("neon.tech") ? { rejectUnauthorized: false } : false,
});
const direction = process.argv[2] === "down" ? "down" : "up";

try {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const directory = path.resolve("migrations");
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const applied = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((row) => row.name));
  if (direction === "up") {
    for (const name of files) {
      if (applied.has(name)) continue;
      const source = await fs.readFile(path.join(directory, name), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [name]);
        const alreadyApplied = await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]);
        if (alreadyApplied.rows.length) { await client.query("COMMIT"); continue; }
        await client.query(source.split("-- migrate:down")[0]);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        console.log(`Applied ${name}`);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
  } else {
    const name = [...files].reverse().find((file) => applied.has(file));
    if (!name) console.log("No migration to roll back");
    else {
      const source = await fs.readFile(path.join(directory, name), "utf8");
      const down = source.split("-- migrate:down")[1];
      if (!down) throw new Error(`${name} has no down migration`);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [name]);
        const stillApplied = await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]);
        if (!stillApplied.rows.length) { await client.query("COMMIT"); console.log(`Migration ${name} was already rolled back`); }
        else {
          await client.query(down);
          await client.query("DELETE FROM schema_migrations WHERE name = $1", [name]);
          await client.query("COMMIT");
          console.log(`Rolled back ${name}`);
        }
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
  }
} finally { await pool.end(); }
