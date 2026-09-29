import { Router } from "express";
import multer from "multer";
import { verifyAdminToken, verifyPlayerToken, type AuthenticatedRequest } from "../middlewares/authentication_middleware";
import { destroyMedia, destroyMediaQuietly, uploadMedia } from "../services/cloudinary_media_service";
import pool from "../config/database_connection";
import { logActivity } from "../helpers/activityLog";

const router = Router();
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, done) => imageTypes.has(file.mimetype)
    ? done(null, true)
    : done(new Error("Only JPEG, PNG, GIF, and WebP images are supported.")),
});

router.post("/admin/media/images", verifyAdminToken, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Select an image to upload." });
  const media = await uploadMedia(req.file, "catalog");
  return res.status(201).json({ success: true, url: media.url });
});

router.delete("/admin/media/images", verifyAdminToken, async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  if (!url) return res.status(400).json({ success: false, message: "Image URL is required." });
  await destroyMedia(url);
  return res.json({ success: true, message: "Image removed." });
});

router.post("/user/profile/image", verifyPlayerToken, upload.single("image"), async (req: AuthenticatedRequest, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Select a profile picture to upload." });
  const current = await pool.query("SELECT profile_image_url FROM users WHERE id=$1 AND role='user'", [req.user!.id]);
  if (!current.rows[0]) return res.status(404).json({ success: false, message: "Profile not found." });
  const media = await uploadMedia(req.file, "profiles");
  try {
    const result = await pool.query(
      `WITH updated AS (
        UPDATE users SET profile_image_url=$1,updated_at=NOW() WHERE id=$2 AND role='user' RETURNING *
       ) SELECT u.id,u.name,u.username,COALESCE(parent.email,u.email) email,u.age,u.profile_image_url,u.total_xp,u.coins_count,u.lives_remaining,u.is_verified,u.is_oauth,u.parent_user_id,(u.parent_user_id IS NULL) "isPrimary",u.created_at,u.updated_at
       FROM updated u LEFT JOIN users parent ON parent.id=u.parent_user_id`,
      [media.url, req.user!.id],
    );
    await destroyMediaQuietly(current.rows[0].profile_image_url);
    await logActivity({ eventType: "user.profile_picture_updated", title: "Profile picture updated", description: `${result.rows[0].name} updated their profile picture`, actorId: req.user!.id, actorName: result.rows[0].name });
    return res.json({ success: true, message: "Profile picture updated.", user: result.rows[0] });
  } catch (error) {
    await destroyMediaQuietly(media);
    throw error;
  }
});

export default router;
