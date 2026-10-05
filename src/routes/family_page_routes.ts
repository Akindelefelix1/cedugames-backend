import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import pool from "../config/database_connection";
import { verifyAdminToken } from "../middlewares/authentication_middleware";
import { destroyMediaQuietly, uploadMedia } from "../services/cloudinary_media_service";
import { logActivity } from "../helpers/activityLog";

const router = Router();
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 10 * 1024 * 1024 }, fileFilter: (_req, file, done) => imageTypes.has(file.mimetype) ? done(null, true) : done(new Error("Only JPEG, PNG, GIF, and WebP images are supported.")) });
const toggleSchema = z.object({ advertEnabled: z.boolean().optional(), sliderEnabled: z.boolean().optional() }).refine((value) => value.advertEnabled !== undefined || value.sliderEnabled !== undefined, "Select a setting to update.");
const isImageBuffer = (file: Express.Multer.File) => {
  const bytes = file.buffer;
  if (file.mimetype === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === "image/png") return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (file.mimetype === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  return file.mimetype === "image/webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
};

async function readSettings() {
  const [settings, slides] = await Promise.all([
    pool.query("SELECT advert_image_url,advert_enabled,slider_enabled,updated_at FROM family_page_settings WHERE id=1"),
    pool.query("SELECT id,image_url,position,created_at FROM family_page_slides ORDER BY position"),
  ]);
  const row = settings.rows[0] || {};
  return { advert: { imageUrl: row.advert_image_url || null, enabled: Boolean(row.advert_enabled) }, slider: { enabled: Boolean(row.slider_enabled), images: slides.rows.map((slide: any) => ({ id: slide.id, imageUrl: slide.image_url, position: slide.position })) }, updatedAt: row.updated_at || null };
}

router.get("/family-page/content", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ success: true, ...(await readSettings()) });
});
router.get("/admin/family-page/content", verifyAdminToken, async (_req, res) => res.json({ success: true, ...(await readSettings()) }));

router.patch("/admin/family-page/content", verifyAdminToken, async (req, res) => {
  const parsed = toggleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Invalid settings." });
  await pool.query(`INSERT INTO family_page_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING`);
  if (parsed.data.advertEnabled) {
    const advert = await pool.query("SELECT advert_image_url FROM family_page_settings WHERE id=1");
    if (!advert.rows[0]?.advert_image_url) return res.status(409).json({ success: false, message: "Upload an advert image before activating it." });
  }
  if (parsed.data.sliderEnabled) {
    const slides = await pool.query("SELECT 1 FROM family_page_slides LIMIT 1");
    if (!slides.rowCount) return res.status(409).json({ success: false, message: "Upload at least one slider image before activating it." });
  }
  await pool.query(`UPDATE family_page_settings SET advert_enabled=COALESCE($1,advert_enabled),slider_enabled=COALESCE($2,slider_enabled),updated_at=NOW() WHERE id=1`, [parsed.data.advertEnabled ?? null, parsed.data.sliderEnabled ?? null]);
  await logActivity({ eventType: "family_page.settings_updated", title: "Family page display updated", description: "Advert or carousel visibility was changed." });
  return res.json({ success: true, ...(await readSettings()) });
});

router.post("/admin/family-page/advert", verifyAdminToken, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Select an advert image to upload." });
  if (!isImageBuffer(req.file)) return res.status(400).json({ success: false, message: "The selected file is not a valid image." });
  const previous = await pool.query("SELECT advert_image_url FROM family_page_settings WHERE id=1");
  const media = await uploadMedia(req.file, "family-page");
  try {
    await pool.query(`INSERT INTO family_page_settings(id,advert_image_url) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET advert_image_url=$1,updated_at=NOW()`, [media.url]);
    await destroyMediaQuietly(previous.rows[0]?.advert_image_url);
    await logActivity({ eventType: "family_page.advert_uploaded", title: "Family page advert uploaded", description: req.file.originalname });
    return res.status(201).json({ success: true, ...(await readSettings()) });
  } catch (error) { await destroyMediaQuietly(media); throw error; }
});

router.delete("/admin/family-page/advert", verifyAdminToken, async (_req, res) => {
  const current = await pool.query("SELECT advert_image_url FROM family_page_settings WHERE id=1");
  await pool.query("UPDATE family_page_settings SET advert_image_url=NULL,advert_enabled=FALSE,updated_at=NOW() WHERE id=1");
  await destroyMediaQuietly(current.rows[0]?.advert_image_url);
  return res.json({ success: true, ...(await readSettings()) });
});

router.post("/admin/family-page/slides", verifyAdminToken, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Select a slider image to upload." });
  if (!isImageBuffer(req.file)) return res.status(400).json({ success: false, message: "The selected file is not a valid image." });
  const count = await pool.query("SELECT COUNT(*)::int total FROM family_page_slides");
  if ((count.rows[0]?.total || 0) >= 3) return res.status(409).json({ success: false, message: "The slider already has the maximum of three images." });
  const media = await uploadMedia(req.file, "family-page");
  try {
    const position = (await pool.query("SELECT COALESCE(MAX(position),0)+1 position FROM family_page_slides")).rows[0].position;
    await pool.query("INSERT INTO family_page_slides(image_url,position) VALUES($1,$2)", [media.url, position]);
    await logActivity({ eventType: "family_page.slide_uploaded", title: "Family page slide uploaded", description: req.file.originalname });
    return res.status(201).json({ success: true, ...(await readSettings()) });
  } catch (error) { await destroyMediaQuietly(media); throw error; }
});

router.delete("/admin/family-page/slides/:id", verifyAdminToken, async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Invalid slider image." });
  const removed = await pool.query("DELETE FROM family_page_slides WHERE id=$1 RETURNING image_url,position", [parsed.data]);
  if (!removed.rows[0]) return res.status(404).json({ success: false, message: "Slider image not found." });
  const remaining = await pool.query("SELECT id,position FROM family_page_slides ORDER BY position");
  for (let index = 0; index < remaining.rows.length; index += 1) {
    if (remaining.rows[index].position !== index + 1) await pool.query("UPDATE family_page_slides SET position=$1 WHERE id=$2", [index + 1, remaining.rows[index].id]);
  }
  if (!remaining.rows.length) await pool.query("UPDATE family_page_settings SET slider_enabled=FALSE,updated_at=NOW() WHERE id=1");
  await destroyMediaQuietly(removed.rows[0].image_url);
  return res.json({ success: true, ...(await readSettings()) });
});

export default router;
