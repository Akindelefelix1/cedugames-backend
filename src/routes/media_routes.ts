import { Router } from "express";
import multer from "multer";
import { verifyAdminToken } from "../middlewares/authentication_middleware";
import { destroyMedia, uploadMedia } from "../services/cloudinary_media_service";

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

export default router;
