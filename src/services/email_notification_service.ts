import pool from "../config/database_connection";
import { env } from "../config/env";
import { SendPlayerNotificationEmail } from "../helpers/Mailer";

export async function deliverEmailNotification(notificationId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM notifications WHERE id=$1 FOR UPDATE", [notificationId]);
    const notification = locked.rows[0];
    if (!notification || !notification.channels?.includes("email") || ["sent", "processing", "not_requested"].includes(notification.email_status)) {
      await client.query("COMMIT");
      return;
    }
    if (!env.ZOHO_MAIL_API_TOKEN || !env.ZOHO_MAIL_FROM) {
      await client.query("UPDATE notifications SET email_status='not_configured' WHERE id=$1", [notificationId]);
      await client.query("COMMIT");
      return;
    }
    await client.query("UPDATE notifications SET email_status='processing',email_started_at=NOW(),email_error=NULL WHERE id=$1", [notificationId]);
    await client.query("COMMIT");

    const recipients = await pool.query(
      `SELECT id,email FROM users
       WHERE role='user' AND parent_user_id IS NULL AND email IS NOT NULL AND email<>''
       AND ($1='all' OR ($1='verified' AND is_verified=true) OR ($1='unverified' AND is_verified=false))
       AND (cardinality($2::uuid[])=0 OR id=ANY($2::uuid[]))`,
      [notification.audience, notification.target_user_ids || []],
    );
    let successCount = 0;
    let failureCount = 0;
    const errors: string[] = [];
    for (let offset = 0; offset < recipients.rows.length; offset += 10) {
      const batch = recipients.rows.slice(offset, offset + 10);
      const results = await Promise.all(batch.map(async (recipient: { email: string }) => {
        try { await SendPlayerNotificationEmail(recipient.email, notification.title, notification.message); return null; }
        catch (error) { return error instanceof Error ? error.message : "Email delivery failed."; }
      }));
      successCount += results.filter(result => result === null).length;
      failureCount += results.filter(result => result !== null).length;
      errors.push(...results.filter((result): result is string => result !== null).slice(0, 3));
    }
    const status = failureCount && !successCount ? "failed" : "sent";
    await pool.query(
      "UPDATE notifications SET email_status=$2,email_started_at=NULL,email_sent_at=NOW(),email_success_count=$3,email_failure_count=$4,email_error=$5 WHERE id=$1",
      [notificationId, status, successCount, failureCount, errors.length ? errors.join("; ").slice(0, 1000) : null],
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await pool.query("UPDATE notifications SET email_status='failed',email_started_at=NULL,email_error=$2 WHERE id=$1", [notificationId, error instanceof Error ? error.message.slice(0, 1000) : "Email delivery failed."]).catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
