import { GoogleAuth } from "google-auth-library";
import pool from "../config/database_connection";
import { env } from "../config/env";
import { deliverEmailNotification } from "./email_notification_service";

let auth: GoogleAuth | null = null;
function getAuth() {
  if (!env.FCM_PROJECT_ID || !env.FCM_SERVICE_ACCOUNT_JSON) return null;
  if (!auth) {
    const credentials = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON);
    auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  }
  return auth;
}

export async function deliverPushNotification(notificationId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM notifications WHERE id=$1 FOR UPDATE", [notificationId]);
    const notification = locked.rows[0];
    if (!notification || !notification.channels?.includes("push") || ["sent", "processing", "not_requested"].includes(notification.push_status)) { await client.query("COMMIT"); return; }
    const googleAuth = getAuth();
    if (!googleAuth) {
      await client.query("UPDATE notifications SET push_status='not_configured' WHERE id=$1", [notificationId]);
      await client.query("COMMIT");
      return;
    }
    await client.query("UPDATE notifications SET push_status='processing',push_started_at=NOW(),push_error=NULL WHERE id=$1", [notificationId]);
    await client.query("COMMIT");

    const tokens = await pool.query(
      `SELECT DISTINCT d.id,d.token FROM push_device_tokens d
       JOIN users device_user ON device_user.id=d.user_id
       JOIN users root_user ON root_user.id=COALESCE(device_user.parent_user_id,device_user.id)
       WHERE (cardinality($1::uuid[])=0 OR root_user.id=ANY($1::uuid[]))
       AND ($2='all' OR ($2='verified' AND root_user.is_verified=true) OR ($2='unverified' AND root_user.is_verified=false))`,
      [notification.target_user_ids || [], notification.audience],
    );
    const accessToken = await (await googleAuth.getClient()).getAccessToken();
    let successCount = 0, failureCount = 0;
    const invalid: string[] = [];
    for (let offset = 0; offset < tokens.rows.length; offset += 500) {
      const batch = tokens.rows.slice(offset, offset + 500);
      const results = await Promise.all(batch.map(async (device: { id: string; token: string }) => {
        try {
          const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FCM_PROJECT_ID)}/messages:send`, {
            method: "POST", headers: { Authorization: `Bearer ${accessToken.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message: { token: device.token, notification: { title: notification.title, body: notification.message }, data: { notificationId, type: notification.type } } }),
          });
          if (response.ok) return { ok: true };
          const detail = await response.json().catch(() => ({})) as any;
          if (detail?.error?.details?.some((item: any) => item.errorCode === "UNREGISTERED")) invalid.push(device.token);
          return { ok: false };
        } catch { return { ok: false }; }
      }));
      successCount += results.filter((result) => result.ok).length;
      failureCount += results.filter((result) => !result.ok).length;
    }
    if (invalid.length) await pool.query("DELETE FROM push_device_tokens WHERE token=ANY($1::text[])", [invalid]);
    await pool.query("UPDATE notifications SET push_status='sent',push_started_at=NULL,push_sent_at=NOW(),push_success_count=$2,push_failure_count=$3 WHERE id=$1", [notificationId, successCount, failureCount]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await pool.query("UPDATE notifications SET push_status='failed',push_started_at=NULL,push_error=$2 WHERE id=$1", [notificationId, error instanceof Error ? error.message.slice(0, 1000) : "Push delivery failed."]).catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function dispatchDuePushNotifications() {
  await pool.query("UPDATE notifications SET push_status='failed',push_started_at=NULL,push_error='Previous delivery timed out.' WHERE push_status='processing' AND push_started_at<NOW()-INTERVAL '5 minutes'");
  await pool.query("UPDATE notifications SET email_status='failed',email_started_at=NULL,email_error='Previous delivery timed out.' WHERE email_status='processing' AND email_started_at<NOW()-INTERVAL '5 minutes'");
  const result = await pool.query("SELECT id,channels,push_status,email_status FROM notifications WHERE ((push_status IN ('pending','failed','not_configured') AND 'push'=ANY(channels)) OR (email_status IN ('pending','failed','not_configured') AND 'email'=ANY(channels))) AND COALESCE(scheduled_at,published_at)<=NOW() ORDER BY COALESCE(scheduled_at,published_at) LIMIT 20");
  for (const row of result.rows) {
    if (row.channels?.includes("push") && ["pending", "failed", "not_configured"].includes(row.push_status)) {
      try { await deliverPushNotification(row.id); }
      catch (error) { console.error(JSON.stringify({ level: "error", event: "push_delivery_failed", notificationId: row.id, message: error instanceof Error ? error.message : "unknown" })); }
    }
    if (row.channels?.includes("email") && ["pending", "failed", "not_configured"].includes(row.email_status)) {
      try { await deliverEmailNotification(row.id); }
      catch (error) { console.error(JSON.stringify({ level: "error", event: "email_delivery_failed", notificationId: row.id, message: error instanceof Error ? error.message : "unknown" })); }
    }
  }
}
