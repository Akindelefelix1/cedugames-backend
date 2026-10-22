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


/** Remove upload audit records outside the 30-day retention window. */
export async function purgeExpiredUploadEvents(): Promise<number> {
  try {
    const result = await pool.query("DELETE FROM admin_upload_events WHERE created_at < NOW() - INTERVAL '30 days'");
    const deleted = result.rowCount || 0;
    if (deleted) console.log(JSON.stringify({ level: "info", event: "admin_upload_events_purged", deleted }));
    return deleted;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "admin_upload_events_purge_failed", message: error instanceof Error ? error.message : "Unknown error" }));
    return 0;
  }
}


export const activityRetentionOptions = [10, 15, 30, 60, 90, 180, 365] as const;
export const defaultActivityRetentionDays = 15;

export async function getActivityRetentionDays(): Promise<number> {
  try {
    const result = await pool.query("SELECT retention_days FROM admin_activity_retention_settings WHERE id=1");
    const days = Number(result.rows[0]?.retention_days || defaultActivityRetentionDays);
    return activityRetentionOptions.includes(days as typeof activityRetentionOptions[number]) ? days : defaultActivityRetentionDays;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "activity_retention_read_failed", message: error instanceof Error ? error.message : "Unknown error" }));
    return defaultActivityRetentionDays;
  }
}

export async function purgeExpiredActivityAndNotifications(retentionDays = defaultActivityRetentionDays): Promise<{ activities: number; notifications: number }> {
  const safeDays = activityRetentionOptions.includes(retentionDays as typeof activityRetentionOptions[number]) ? retentionDays : defaultActivityRetentionDays;
  try {
    const [activities, notifications] = await Promise.all([
      pool.query("DELETE FROM activity_logs WHERE metadata->>'institutionId' IS NULL AND created_at < NOW() - ($1 * INTERVAL '1 day')", [safeDays]),
      pool.query("DELETE FROM notifications WHERE published_at < NOW() - ($1 * INTERVAL '1 day')", [safeDays]),
    ]);
    const deleted = { activities: activities.rowCount || 0, notifications: notifications.rowCount || 0 };
    if (deleted.activities || deleted.notifications) console.log(JSON.stringify({ level: "info", event: "activity_retention_purged", retentionDays: safeDays, ...deleted }));
    return deleted;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "activity_retention_purge_failed", retentionDays: safeDays, message: error instanceof Error ? error.message : "Unknown error" }));
    return { activities: 0, notifications: 0 };
  }
}

/** Remove institution activity according to each institution's own retention policy. */
export async function purgeExpiredInstitutionActivity(institutionId?: string): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM activity_logs a
       USING institutions i
       WHERE a.metadata->>'institutionId'=i.id::text
         AND a.created_at < NOW() - (i.activity_retention_days * INTERVAL '1 day')
         AND ($1::uuid IS NULL OR i.id=$1::uuid)`,
      [institutionId || null],
    );
    const deleted = result.rowCount || 0;
    if (deleted) console.log(JSON.stringify({ level: "info", event: "institution_activity_purged", deleted, institutionId: institutionId || null }));
    return deleted;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "institution_activity_purge_failed", institutionId: institutionId || null, message: error instanceof Error ? error.message : "Unknown error" }));
    return 0;
  }
}

/** Keep completed institution practice history for 30 days. Also clear abandoned attempts. */
export async function purgeExpiredInstitutionLearningHistory(): Promise<number> {
  try {
    const plays = await pool.query("DELETE FROM institution_practice_plays WHERE started_at < NOW() - INTERVAL '30 days'");
    const legacyAttempts = await pool.query("DELETE FROM institution_question_attempts WHERE play_id IS NULL AND started_at < NOW() - INTERVAL '30 days'");
    const deleted = (plays.rowCount || 0) + (legacyAttempts.rowCount || 0);
    if (deleted) console.log(JSON.stringify({ level: "info", event: "institution_learning_history_purged", deleted, retentionDays: 30 }));
    return deleted;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "institution_learning_history_purge_failed", message: error instanceof Error ? error.message : "Unknown error" }));
    return 0;
  }
}
