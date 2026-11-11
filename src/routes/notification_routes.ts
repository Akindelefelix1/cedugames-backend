import { Router } from "express";
import { z } from "zod";
import pool from "../config/database_connection";
import { verifyAdminToken, verifyPlayerToken, type AuthenticatedRequest } from "../middlewares/authentication_middleware";
import { activityRetentionOptions, defaultActivityRetentionDays, getActivityRetentionDays, logActivity, purgeExpiredActivityAndNotifications } from "../helpers/activityLog";
import { deliverPushNotification } from "../services/push_notification_service";

const router = Router();
const uuid = z.string().uuid();
const createSchema = z.object({ title: z.string().trim().min(3).max(160), message: z.string().trim().min(5).max(3000), type: z.enum(["announcement", "achievement", "reminder", "system"]).default("announcement"), audience: z.enum(["all", "verified", "unverified"]).default("all"), targetUserIds: z.array(z.string().uuid()).max(5000).default([]), scheduledAt: z.string().datetime({ offset: true }).nullable().optional() });
const retentionSchema = z.object({ retentionDays: z.number().int().refine(value => activityRetentionOptions.includes(value as typeof activityRetentionOptions[number])) });
const pageInfo = (q: any) => ({ page: Math.max(1, Number(q.page) || 1), limit: Math.min(50, Math.max(1, Number(q.limit) || 10)) });
const audienceSql = `(n.audience='all' OR (n.audience='verified' AND u.is_verified=true) OR (n.audience='unverified' AND u.is_verified=false)) AND (cardinality(n.target_user_ids)=0 OR u.id=ANY(n.target_user_ids) OR u.parent_user_id=ANY(n.target_user_ids))`;

router.get("/admin/activity-retention", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  const retentionDays = await getActivityRetentionDays();
  return res.json({ success: true, retentionDays, options: activityRetentionOptions, canEdit: req.user!.id === "super-admin" });
});

router.put("/admin/activity-retention", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  if (req.user!.id !== "super-admin") return res.status(403).json({ success: false, message: "Only the Super Admin can change activity retention." });
  const parsed = retentionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: `Choose one of these retention periods: ${activityRetentionOptions.join(", ")} days.` });
  const { retentionDays } = parsed.data;
  await pool.query(`INSERT INTO admin_activity_retention_settings(id,retention_days) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET retention_days=EXCLUDED.retention_days,updated_at=NOW()`, [retentionDays]);
  await purgeExpiredActivityAndNotifications(retentionDays);
  await logActivity({ eventType: "admin.activity_retention_updated", title: "Activity retention updated", description: `Activity and notifications are retained for ${retentionDays} days.`, actorId: req.user!.id, actorName: "Super Admin", metadata: { retentionDays } });
  return res.json({ success: true, retentionDays, message: `Activity and notifications will be retained for ${retentionDays} days.` });
});

router.post("/admin/notifications", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, errors: parsed.error.issues });
  const data = parsed.data;
  const actorId = req.user!.id === "super-admin" ? null : req.user!.id;
  const actorName = req.user!.id === "super-admin" ? "Super Admin" : null;
  const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
  if (scheduledAt && scheduledAt.getTime() < Date.now() + 30_000) return res.status(400).json({ success: false, message: "Choose a schedule at least 30 seconds in the future." });
  const targetUserIds = [...new Set(data.targetUserIds)];
  if (targetUserIds.length) {
    const users = await pool.query("SELECT id FROM users WHERE role='user' AND parent_user_id IS NULL AND id=ANY($1::uuid[])", [targetUserIds]);
    if (users.rowCount !== targetUserIds.length) return res.status(400).json({ success: false, message: "One or more selected players are unavailable." });
  }
  const result = await pool.query(`INSERT INTO notifications(title,message,type,audience,created_by,created_by_name,target_user_ids,scheduled_at,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($8,NOW())) RETURNING *`, [data.title, data.message, data.type, data.audience, actorId, actorName, targetUserIds, scheduledAt]);
  await logActivity({ eventType: scheduledAt ? "notifications.scheduled" : "notifications.sent", title: scheduledAt ? "Player notification scheduled" : "Player notification sent", description: `${data.title} was ${scheduledAt ? "scheduled for " + scheduledAt.toISOString() : "sent"} to ${targetUserIds.length ? targetUserIds.length + " selected players" : data.audience + " players"}`, actorId, actorName, metadata: { notificationId: result.rows[0].id, audience: data.audience, targetUserIds, scheduledAt } });
  if (!scheduledAt) void deliverPushNotification(result.rows[0].id).catch((error) => console.error("Push delivery failed", error));
  return res.status(201).json({ success: true, message: scheduledAt ? "Notification scheduled." : "Notification published; push delivery has started.", notification: result.rows[0] });
});

router.put("/notifications/device-token", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ token: z.string().trim().min(20).max(4096), platform: z.enum(["android", "ios"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "A valid device token and platform are required." });
  await pool.query(`INSERT INTO push_device_tokens(user_id,token,platform,last_seen_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(token) DO UPDATE SET user_id=EXCLUDED.user_id,platform=EXCLUDED.platform,last_seen_at=NOW()`, [req.user!.accountId || req.user!.id, parsed.data.token, parsed.data.platform]);
  return res.json({ success: true });
});

router.delete("/notifications/device-token", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const token = String(req.body?.token || "");
  if (token) await pool.query("DELETE FROM push_device_tokens WHERE user_id=$1 AND token=$2", [req.user!.accountId || req.user!.id, token]);
  return res.json({ success: true });
});

router.get("/admin/notifications", verifyAdminToken, async (req, res) => {
  const { page, limit } = pageInfo(req.query);
  const retentionDays = await getActivityRetentionDays();
  const campaignFilter = "(push_status<>'sent' OR push_sent_at IS NOT NULL OR scheduled_at IS NOT NULL)";
  const [count, rows] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int total FROM notifications WHERE published_at >= NOW() - ($1 * INTERVAL '1 day') AND ${campaignFilter}`, [retentionDays]),
    pool.query(`SELECT * FROM notifications WHERE published_at >= NOW() - ($1 * INTERVAL '1 day') AND ${campaignFilter} ORDER BY published_at DESC LIMIT $2 OFFSET $3`, [retentionDays, limit, (page - 1) * limit]),
  ]);
  const total = Number(count.rows[0].total);
  return res.json({ success: true, notifications: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

router.get("/notifications", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const { page, limit } = pageInfo(req.query);
  const retentionDays = await getActivityRetentionDays();
  const unreadOnly = String(req.query.unreadOnly || "false") === "true";
  const extra = unreadOnly ? "AND nr.user_id IS NULL" : "";
  const userId = req.user!.id;
  const [count, rows, unread] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int total FROM notifications n CROSS JOIN users u LEFT JOIN notification_reads nr ON nr.notification_id=n.id AND nr.user_id=u.id WHERE u.id=$1 AND n.published_at<=NOW() AND n.published_at >= NOW() - ($2 * INTERVAL '1 day') AND ${audienceSql} ${extra}`, [userId, retentionDays]),
    pool.query(`SELECT n.id,n.title,n.message,n.type,n.published_at,n.created_by_name,(nr.user_id IS NOT NULL) is_read FROM notifications n CROSS JOIN users u LEFT JOIN notification_reads nr ON nr.notification_id=n.id AND nr.user_id=u.id WHERE u.id=$1 AND n.published_at<=NOW() AND n.published_at >= NOW() - ($2 * INTERVAL '1 day') AND ${audienceSql} ${extra} ORDER BY n.published_at DESC LIMIT $3 OFFSET $4`, [userId, retentionDays, limit, (page - 1) * limit]),
    pool.query(`SELECT COUNT(*)::int total FROM notifications n CROSS JOIN users u LEFT JOIN notification_reads nr ON nr.notification_id=n.id AND nr.user_id=u.id WHERE u.id=$1 AND n.published_at<=NOW() AND n.published_at >= NOW() - ($2 * INTERVAL '1 day') AND ${audienceSql} AND nr.user_id IS NULL`, [userId, retentionDays]),
  ]);
  return res.json({ success: true, notifications: rows.rows, unreadCount: Number(unread.rows[0].total), pagination: { page, limit, total: Number(count.rows[0].total), totalPages: Math.ceil(Number(count.rows[0].total) / limit) } });
});

router.patch("/notifications/read-all", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const retentionDays = await getActivityRetentionDays();
  await pool.query(`INSERT INTO notification_reads(notification_id,user_id) SELECT n.id,u.id FROM notifications n CROSS JOIN users u WHERE u.id=$1 AND n.published_at<=NOW() AND n.published_at >= NOW() - ($2 * INTERVAL '1 day') AND ${audienceSql} ON CONFLICT DO NOTHING`, [req.user!.id, retentionDays]);
  return res.json({ success: true, message: "All notifications marked as read." });
});

router.patch("/notifications/:id/read", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ success: false, message: "Invalid notification." });
  const retentionDays = await getActivityRetentionDays();
  const result = await pool.query(`INSERT INTO notification_reads(notification_id,user_id) SELECT n.id,u.id FROM notifications n CROSS JOIN users u WHERE n.id=$1 AND u.id=$2 AND n.published_at<=NOW() AND n.published_at >= NOW() - ($3 * INTERVAL '1 day') AND ${audienceSql} ON CONFLICT DO NOTHING RETURNING notification_id`, [req.params.id, req.user!.id, retentionDays]);
  if (!result.rows[0]) {
    const exists = await pool.query("SELECT 1 FROM notification_reads WHERE notification_id=$1 AND user_id=$2", [req.params.id, req.user!.id]);
    if (!exists.rows[0]) return res.status(404).json({ success: false, message: "Notification not found." });
  }
  return res.json({ success: true });
});

export default router;
