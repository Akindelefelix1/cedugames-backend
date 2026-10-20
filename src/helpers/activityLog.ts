import pool from "../config/database_connection";
import type { AuthenticatedRequest } from "../middlewares/authentication_middleware";

export type ActivityInput = {
  eventType: string;
  title: string;
  description: string;
  actorId?: string | null;
  actorName?: string | null;
  metadata?: Record<string, unknown>;
};

export type UploadEventInput = {
  actorId?: string | null;
  actorName?: string | null;
  questionCount?: number;
  imageCount?: number;
  uploadType: string;
  metadata?: Record<string, unknown>;
};

export async function getAdminActor(req: AuthenticatedRequest): Promise<{ actorId: string | null; actorName: string }> {
  if (req.user?.id === "super-admin") return { actorId: null, actorName: "Super Admin" };
  const result = await pool.query("SELECT id,name FROM users WHERE id=$1 AND role='admin'", [req.user?.id || null]);
  return { actorId: result.rows[0]?.id || req.user?.id || null, actorName: result.rows[0]?.name || "Administrator" };
}

/** Immutable, query-friendly ledger for content contribution reporting. */
export async function recordUploadEvent(upload: UploadEventInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO admin_upload_events(actor_id,actor_name,upload_type,question_count,image_count,metadata)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [upload.actorId || null, upload.actorName || null, upload.uploadType, upload.questionCount || 0, upload.imageCount || 0, JSON.stringify(upload.metadata || {})],
    );
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "admin_upload_event_failed", uploadType: upload.uploadType, message: error instanceof Error ? error.message : "Unknown error" }));
  }
}

/** Shared activity writer for product events administrators need to monitor. */
export async function logActivity(activity: ActivityInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO activity_logs(event_type,title,description,actor_id,actor_name,metadata)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [activity.eventType, activity.title, activity.description, activity.actorId || null, activity.actorName || null, JSON.stringify(activity.metadata || {})],
    );
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "activity_log_failed", activityType: activity.eventType, message: error instanceof Error ? error.message : "Unknown error" }));
  }
}
