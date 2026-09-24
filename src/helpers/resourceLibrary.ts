import type { PoolClient } from "pg";
import pool from "../config/database_connection";
import type { StoredMedia } from "../services/cloudinary_media_service";

type QueryClient = Pick<PoolClient, "query">;

export async function registerImageResource(
  media: StoredMedia | undefined,
  file: Express.Multer.File | undefined,
  client: QueryClient = pool,
) {
  if (!media || !file?.mimetype.startsWith("image/")) return;
  await client.query(
    `INSERT INTO resources(name,url,public_id,resource_type,mime_type,source)
     VALUES($1,$2,$3,'image',$4,'question')
     ON CONFLICT(url) DO NOTHING`,
    [file.originalname.slice(0, 255), media.url, media.publicId || null, file.mimetype],
  );
}

export async function assertResourceUrls(client: QueryClient, urls: Array<string | null | undefined>) {
  const unique = [...new Set(urls.filter(Boolean) as string[])];
  if (!unique.length) return;
  const result = await client.query("SELECT url FROM resources WHERE url = ANY($1::text[])", [unique]);
  if (result.rowCount !== unique.length) throw Object.assign(new Error("One or more selected resources are no longer available."), { status: 400 });
}

export async function destroyOnlyUnmanaged(urls: string[]) {
  const unique = [...new Set(urls.filter(Boolean))];
  if (!unique.length) return [];
  const managed = await pool.query("SELECT url FROM resources WHERE url = ANY($1::text[])", [unique]);
  const managedUrls = new Set(managed.rows.map((row: { url: string }) => row.url));
  return unique.filter((url) => !managedUrls.has(url));
}
