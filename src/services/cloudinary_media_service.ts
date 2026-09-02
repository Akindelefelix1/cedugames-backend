import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from "cloudinary";
import { env } from "../config/env";

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

export type StoredMedia = {
  url: string;
  publicId: string;
  resourceType: string;
};

export const uploadMedia = (file: Express.Multer.File, subfolder = "questions"): Promise<StoredMedia> => new Promise((resolve, reject) => {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    reject(new Error("Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET."));
    return;
  }
  const options: UploadApiOptions = {
    folder: `${env.CLOUDINARY_FOLDER}/${subfolder}`,
    resource_type: "auto",
    use_filename: true,
    unique_filename: true,
    overwrite: false,
  };
  const stream = cloudinary.uploader.upload_stream(options, (error, result?: UploadApiResponse) => {
    if (error || !result) return reject(error || new Error("Cloudinary upload failed."));
    resolve({ url: result.secure_url, publicId: result.public_id, resourceType: result.resource_type });
  });
  stream.end(file.buffer);
});

const cloudinaryAsset = (url: string): { publicId: string; resourceType: string } | null => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "res.cloudinary.com") return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const uploadIndex = segments.indexOf("upload");
    if (uploadIndex < 2) return null;
    const resourceType = segments[uploadIndex - 1];
    const assetSegments = segments.slice(uploadIndex + 1);
    if (/^v\d+$/.test(assetSegments[0] || "")) assetSegments.shift();
    const finalSegment = assetSegments.pop();
    if (!finalSegment) return null;
    assetSegments.push(finalSegment.replace(/\.[^.]+$/, ""));
    return { publicId: assetSegments.join("/"), resourceType: resourceType! };
  } catch {
    return null;
  }
};

export const destroyMedia = async (media: StoredMedia | string | null | undefined): Promise<void> => {
  if (!media) return;
  const asset = typeof media === "string" ? cloudinaryAsset(media) : media;
  if (!asset) return;
  await cloudinary.uploader.destroy(asset.publicId, { resource_type: asset.resourceType, invalidate: true });
};

export const destroyMediaQuietly = async (media: StoredMedia | string | null | undefined): Promise<void> => {
  try { await destroyMedia(media); }
  catch (error) { console.error("Cloudinary media cleanup failed", { media, error }); }
};
