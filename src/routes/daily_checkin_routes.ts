import { Router } from "express";
import { z } from "zod";
import pool from "../config/database_connection";
import { verifyAdminToken, verifyPlayerToken, type AuthenticatedRequest } from "../middlewares/authentication_middleware";
import { recordCoinTransaction } from "../services/coin_service";

const router = Router();
const rewardSchema = z.object({ day: z.number().int().min(1).max(365), coins: z.number().int().min(1).max(1_000_000) });
const settingsSchema = z.object({
  isEnabled: z.boolean(), timezone: z.string().trim().min(1).max(80),
  title: z.string().trim().min(2).max(120), subtitle: z.string().trim().max(300),
  rewards: z.array(rewardSchema).min(1).max(365),
  repeatCycle: z.boolean(), resetAfterMissedDays: z.number().int().min(1).max(365),
});
const shapeSettings = (row: any) => ({
  isEnabled: row.is_enabled, timezone: row.timezone, title: row.title, subtitle: row.subtitle,
  rewards: row.rewards, repeatCycle: row.repeat_cycle,
  resetAfterMissedDays: row.reset_after_missed_days, updatedAt: row.updated_at,
});
const statusFor = async (userId: string) => {
  const result = await pool.query(
    `SELECT s.*, (NOW() AT TIME ZONE s.timezone)::date today,
      c.checkin_date last_checkin_date,c.streak,c.cycle_day,c.reward_amount,
      CASE WHEN c.checkin_date IS NULL THEN NULL ELSE (NOW() AT TIME ZONE s.timezone)::date-c.checkin_date END days_since_last,
      EXISTS(SELECT 1 FROM daily_checkins d WHERE d.user_id=$1 AND d.checkin_date=(NOW() AT TIME ZONE s.timezone)::date) checked_in_today
     FROM daily_checkin_settings s
     LEFT JOIN LATERAL (SELECT * FROM daily_checkins WHERE user_id=$1 ORDER BY checkin_date DESC LIMIT 1) c ON true
     WHERE s.id=1`, [userId],
  );
  const row = result.rows[0];
  const rewards = row.rewards as Array<{ day: number; coins: number }>;
  const recordedStreak = Number(row.streak || 0);
  const continues = row.days_since_last !== null && Number(row.days_since_last) <= Number(row.reset_after_missed_days);
  const currentStreak = row.checked_in_today || continues ? recordedStreak : 0;
  const nextStreak = row.checked_in_today ? currentStreak : continues ? recordedStreak + 1 : 1;
  const nextIndex = row.repeat_cycle ? (nextStreak - 1) % rewards.length : Math.min(nextStreak - 1, rewards.length - 1);
  return { ...shapeSettings(row), today: row.today, checkedInToday: row.checked_in_today,
    currentStreak, currentCycleDay: Number(row.cycle_day || 0), lastCheckinDate: row.last_checkin_date, lastReward: Number(row.reward_amount || 0),
    nextReward: Number(rewards[nextIndex]?.coins || 0), nextCycleDay: nextIndex + 1 };
};

router.get("/daily-checkin/status", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  res.json({ success: true, status: await statusFor(req.user!.id) });
});

router.post("/daily-checkin/claim", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const configResult = await client.query("SELECT *, (NOW() AT TIME ZONE timezone)::date today FROM daily_checkin_settings WHERE id=1 FOR UPDATE");
    const config = configResult.rows[0];
    if (!config.is_enabled) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Daily check-in rewards are currently paused." }); }
    const existing = await client.query("SELECT * FROM daily_checkins WHERE user_id=$1 AND checkin_date=$2", [req.user!.id, config.today]);
    if (existing.rows[0]) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, code: "ALREADY_CHECKED_IN", message: "You already collected today's reward." }); }
    const lastResult = await client.query("SELECT * FROM daily_checkins WHERE user_id=$1 ORDER BY checkin_date DESC LIMIT 1 FOR UPDATE", [req.user!.id]);
    const last = lastResult.rows[0];
    let streak = 1;
    if (last) {
      const gap = await client.query("SELECT $1::date - $2::date AS days", [config.today, last.checkin_date]);
      if (Number(gap.rows[0].days) <= Number(config.reset_after_missed_days)) streak = Number(last.streak) + 1;
    }
    const rewards = config.rewards as Array<{ day: number; coins: number }>;
    const rewardIndex = config.repeat_cycle ? (streak - 1) % rewards.length : Math.min(streak - 1, rewards.length - 1);
    const selectedReward = rewards[rewardIndex];
    if (!selectedReward) throw Object.assign(new Error("The daily reward schedule is empty."), { status: 500 });
    const reward = Number(selectedReward.coins);
    const reference = `daily-checkin:${req.user!.id}:${config.today}`;
    const transaction = await recordCoinTransaction({
      userId: req.user!.id, type: "reward", amount: reward,
      description: `${config.title} · Day ${streak}`, reference,
      metadata: { eventKey: "daily_checkin", checkinDate: config.today, streak, cycleDay: rewardIndex + 1 },
    }, client);
    const checkin = await client.query(
      `INSERT INTO daily_checkins(user_id,checkin_date,streak,cycle_day,reward_amount,transaction_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user!.id, config.today, streak, rewardIndex + 1, reward, transaction.id],
    );
    await client.query("COMMIT");
    return res.status(201).json({ success: true, message: `Check-in complete! You earned ${reward} coins.`, checkin: checkin.rows[0], balance: transaction.balance_after, status: await statusFor(req.user!.id) });
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return res.status(409).json({ success: false, code: "ALREADY_CHECKED_IN", message: "You already collected today's reward." });
    throw error;
  } finally { client.release(); }
});

const admin = Router();
admin.use(verifyAdminToken);
admin.get("/settings", async (_req, res) => {
  const result = await pool.query("SELECT * FROM daily_checkin_settings WHERE id=1");
  res.json({ success: true, settings: shapeSettings(result.rows[0]) });
});
admin.put("/settings", async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Invalid settings." });
  const d = parsed.data;
  try { new Intl.DateTimeFormat("en-US", { timeZone: d.timezone }).format(); }
  catch { return res.status(400).json({ success: false, message: "Use a valid IANA timezone, such as Africa/Lagos." }); }
  const days = d.rewards.map((reward) => reward.day);
  if (new Set(days).size !== days.length) return res.status(400).json({ success: false, message: "Every reward day must be unique." });
  const rewards = [...d.rewards].sort((a, b) => a.day - b.day).map((reward, index) => ({ ...reward, day: index + 1 }));
  const result = await pool.query(
    `UPDATE daily_checkin_settings SET is_enabled=$1,timezone=$2,title=$3,subtitle=$4,rewards=$5,
      repeat_cycle=$6,reset_after_missed_days=$7,updated_at=NOW() WHERE id=1 RETURNING *`,
    [d.isEnabled, d.timezone, d.title, d.subtitle, JSON.stringify(rewards), d.repeatCycle, d.resetAfterMissedDays],
  );
  res.json({ success: true, message: "Daily reward settings updated.", settings: shapeSettings(result.rows[0]) });
});
admin.get("/activity", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const [summary, count, rows] = await Promise.all([
    pool.query(`SELECT COUNT(*) FILTER(WHERE d.checkin_date=(NOW() AT TIME ZONE s.timezone)::date)::int today,
      COUNT(DISTINCT d.user_id)::int unique_players,COALESCE(SUM(d.reward_amount),0)::bigint total_awarded,
      COALESCE(MAX(d.streak),0)::int longest_streak FROM daily_checkins d CROSS JOIN daily_checkin_settings s WHERE s.id=1`),
    pool.query("SELECT COUNT(*)::int total FROM daily_checkins"),
    pool.query(`SELECT d.*,u.name user_name,u.email user_email FROM daily_checkins d JOIN users u ON u.id=d.user_id
      ORDER BY d.created_at DESC LIMIT $1 OFFSET $2`, [limit, (page - 1) * limit]),
  ]);
  res.json({ success: true, summary: summary.rows[0], checkins: rows.rows, pagination: { page, limit, total: Number(count.rows[0].total) } });
});
router.use("/admin/daily-checkin", admin);

export default router;
