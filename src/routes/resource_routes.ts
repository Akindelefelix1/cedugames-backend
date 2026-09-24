import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import pool from "../config/database_connection";
import { logActivity } from "../helpers/activityLog";
import { verifyAdminToken } from "../middlewares/authentication_middleware";
import { destroyMediaQuietly, uploadMedia } from "../services/cloudinary_media_service";

const router = Router();
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, done) => imageTypes.has(file.mimetype) ? done(null, true) : done(new Error("Only JPEG, PNG, GIF, and WebP images are supported.")),
});
const categorySchema = z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).default("") });

router.get("/admin/resource-categories", verifyAdminToken, async (_req, res) => {
  const result = await pool.query(
    `SELECT c.id,c.name,c.description,c.created_at,COUNT(r.id)::int asset_count
     FROM resource_categories c LEFT JOIN resources r ON r.category_id=c.id
     GROUP BY c.id ORDER BY LOWER(c.name)`,
  );
  res.json({ success: true, categories: result.rows.map((row: Record<string, any>) => ({ id: row.id, name: row.name, description: row.description, assetCount: row.asset_count, createdAt: row.created_at })) });
});

router.post("/admin/resource-categories", verifyAdminToken, async (req, res) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Enter a valid category name." });
  try {
    const result = await pool.query("INSERT INTO resource_categories(name,description) VALUES($1,$2) RETURNING *", [parsed.data.name, parsed.data.description]);
    return res.status(201).json({ success: true, category: result.rows[0] });
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "A resource category with this name already exists." });
    throw error;
  }
});

router.patch("/admin/resource-categories/:id", verifyAdminToken, async (req, res) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Enter a valid category name." });
  try {
    const result = await pool.query("UPDATE resource_categories SET name=$1,description=$2,updated_at=NOW() WHERE id=$3 RETURNING *", [parsed.data.name, parsed.data.description, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Resource category not found." });
    return res.json({ success: true, category: result.rows[0] });
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "A resource category with this name already exists." });
    throw error;
  }
});

router.delete("/admin/resource-categories/:id", verifyAdminToken, async (req, res) => {
  const result = await pool.query("DELETE FROM resource_categories WHERE id=$1 RETURNING id", [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Resource category not found." });
  return res.json({ success: true, message: "Category removed. Its images remain in All resources." });
});

router.get("/admin/resources", verifyAdminToken, async (req, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(60, Math.max(12, Number.parseInt(String(req.query.limit || "24"), 10) || 24));
  const search = String(req.query.search || "").trim();
  const categoryId = String(req.query.categoryId || "").trim();
  const filters: string[] = [];
  const values: unknown[] = [];
  if (search) { values.push(`%${search}%`); filters.push(`r.name ILIKE $${values.length}`); }
  if (categoryId) { values.push(categoryId); filters.push(`r.category_id=$${values.length}`); }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const count = await pool.query(`SELECT COUNT(*)::int total FROM resources r ${where}`, values);
  values.push(limit, (page - 1) * limit);
  const result = await pool.query(
    `SELECT r.*,c.name category_name,
       ((SELECT COUNT(*) FROM questions q WHERE q.media_url=r.url) + (SELECT COUNT(*) FROM question_options o WHERE o.media_url=r.url))::int usage_count
     FROM resources r LEFT JOIN resource_categories c ON c.id=r.category_id ${where}
     ORDER BY r.created_at DESC,r.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = count.rows[0]?.total || 0;
  res.json({ success: true, resources: result.rows.map((row: Record<string, any>) => ({ id: row.id, categoryId: row.category_id, categoryName: row.category_name, name: row.name, url: row.url, mimeType: row.mime_type, source: row.source, usageCount: row.usage_count, createdAt: row.created_at })), pagination: { page, pageSize: limit, total, totalPages: Math.ceil(total / limit) } });
});

router.post("/admin/resources", verifyAdminToken, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Select an image to upload." });
  const categoryId = String(req.body.categoryId || "").trim() || null;
  if (categoryId) {
    const category = await pool.query("SELECT 1 FROM resource_categories WHERE id=$1", [categoryId]);
    if (!category.rowCount) return res.status(400).json({ success: false, message: "Select a valid resource category." });
  }
  const media = await uploadMedia(req.file, "resources");
  try {
    const result = await pool.query(
      `INSERT INTO resources(category_id,name,url,public_id,resource_type,mime_type,source)
       VALUES($1,$2,$3,$4,'image',$5,'upload') RETURNING *`,
      [categoryId, String(req.body.name || req.file.originalname).trim().slice(0, 255), media.url, media.publicId || null, req.file.mimetype],
    );
    await logActivity({ eventType: "resources.image_uploaded", title: "Resource image uploaded", description: result.rows[0].name });
    return res.status(201).json({ success: true, resource: result.rows[0] });
  } catch (error) { await destroyMediaQuietly(media); throw error; }
});

router.patch("/admin/resources/:id", verifyAdminToken, async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(255), categoryId: z.string().uuid().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter a valid resource name and category." });
  const result = await pool.query("UPDATE resources SET name=$1,category_id=$2,updated_at=NOW() WHERE id=$3 RETURNING *", [parsed.data.name, parsed.data.categoryId || null, req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Resource not found." });
  return res.json({ success: true, resource: result.rows[0] });
});

router.delete("/admin/resources/:id", verifyAdminToken, async (req, res) => {
  const current = await pool.query(
    `SELECT r.*,((SELECT COUNT(*) FROM questions q WHERE q.media_url=r.url) + (SELECT COUNT(*) FROM question_options o WHERE o.media_url=r.url))::int usage_count
     FROM resources r WHERE r.id=$1`, [req.params.id],
  );
  if (!current.rows[0]) return res.status(404).json({ success: false, message: "Resource not found." });
  if (current.rows[0].usage_count > 0) return res.status(409).json({ success: false, message: "This image is used by a question. Replace it there before deleting it from Resources." });
  await pool.query("DELETE FROM resources WHERE id=$1", [req.params.id]);
  await destroyMediaQuietly(current.rows[0].url);
  return res.json({ success: true, message: "Resource deleted." });
});

export default router;
