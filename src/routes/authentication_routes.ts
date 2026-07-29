import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { rateLimit } from "express-rate-limit";
import pool from "../config/database_connection";
import { env } from "../config/env";
import { comparePassword, hashPassword } from "../helpers/hashPassword";
import { SendOtp } from "../helpers/Mailer";
import { generateOtp, hashOtp } from "../helpers/otp";
import { logActivity } from "../helpers/activityLog";
import { verifyAdminToken, verifyPlayerToken, type AuthenticatedRequest } from "../middlewares/authentication_middleware";
import {
  AdminLoginSchema, ForgotPasswordSchema, GoogleAuthSchema, LoginSchema, RegisterUserSchema,
  ResendOtpSchema, ResetPasswordSchema, UpdatePassword, VerifyOtpSchema,
  UpdateProfileSchema,
} from "../schemas/authentication_schema";
import { z } from "zod";

const router = Router();
const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID || undefined);
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
const sensitiveLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false });
router.use(authLimiter);

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const signSession = (user: { id: string; role: string; token_version: number }) =>
  jwt.sign({ id: user.id, role: user.role, ver: user.token_version }, env.JWT_SECRET, {
    expiresIn: "24h", issuer: "cedugames-api", audience: "cedugames-client",
  });

const signAdminSession = (admin: { id: string; role: string; token_version: number }) =>
  jwt.sign({ id: admin.id, role: admin.role, ver: admin.token_version }, env.JWT_SECRET, {
    expiresIn: "12h", issuer: "cedugames-api", audience: "cedugames-admin",
  });

router.post("/admin/login", sensitiveLimiter, async (req, res) => {
  const validation = AdminLoginSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, errors: validation.error.issues });
  const email = normalizeEmail(validation.data.email);

  if (email === normalizeEmail(env.SUPER_ADMIN_EMAIL) && validation.data.password === env.SUPER_ADMIN_PASSWORD) {
    const admin = { id: "super-admin", name: "Super Admin", email, role: "Super Admin", permissions: ["*"], token_version: 0 };
    await logActivity({ eventType: "admin.signed_in", title: "Admin signed in", description: "Super Admin signed in", actorName: admin.name });
    return res.json({ success: true, message: "Admin sign in successful.", token: signAdminSession({ id: admin.id, role: "super_admin", token_version: 0 }), user: admin });
  }

  try {
    const result = await pool.query("SELECT id,name,email,password,role,is_verified,is_active,admin_title,admin_permissions,token_version FROM users WHERE lower(email)=$1 AND role='admin'", [email]);
    const admin = result.rows[0];
    const matches = admin?.password ? await comparePassword(validation.data.password, admin.password) : false;
    if (!matches) return res.status(401).json({ success: false, message: "Invalid admin email or password." });
    if (!admin.is_verified) return res.status(403).json({ success: false, message: "Verify this admin account before signing in." });
    if (!admin.is_active) return res.status(403).json({ success: false, message: "This administrator account has been deactivated." });
    const user = { id: admin.id, name: admin.name, email: admin.email, role: admin.admin_title, permissions: admin.admin_permissions || [] };
    await logActivity({ eventType: "admin.signed_in", title: "Admin signed in", description: `${admin.name} signed in`, actorId: admin.id, actorName: admin.name });
    return res.json({ success: true, message: "Admin sign in successful.", token: signAdminSession(admin), user });
  } catch (error) {
    console.error("Admin login failed", error);
    return res.status(500).json({ success: false, message: "Admin sign in could not be completed." });
  }
});

router.get("/admin/users", verifyAdminToken, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,name,username,email,age,total_xp,coins_count,lives_remaining,is_verified,created_at
       FROM users WHERE role='user' ORDER BY created_at DESC`,
    );
    return res.json({ success: true, count: result.rowCount || 0, users: result.rows });
  } catch (error) {
    console.error("Admin user listing failed", error);
    return res.status(500).json({ success: false, message: "Users could not be loaded." });
  }
});

router.get("/admin/users/:id", verifyAdminToken, async (req, res) => {
  const userId = String(req.params.id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return res.status(400).json({ success: false, message: "Invalid user ID." });
  }
  try {
    const userResult = await pool.query(
      `SELECT id,name,username,email,age,role,total_xp,coins_count,lives_remaining,
       is_verified,is_oauth,created_at,updated_at
       FROM users WHERE id=$1 AND role='user'`,
      [userId],
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const [performance, attempts, coinTransactions, purchases, earnedBadges] = await Promise.all([
      pool.query(
        `SELECT COUNT(a.id)::int attempts,
         COUNT(a.id) FILTER (WHERE a.passed)::int passed_attempts,
         COUNT(DISTINCT a.level_id) FILTER (WHERE a.passed)::int completed_levels,
         COALESCE(ROUND(AVG(a.score_percent)),0)::int average_score,
         COALESCE(MAX(a.score_percent),0)::int best_score,
         COALESCE(SUM(a.correct_answers),0)::int correct_answers,
         COALESCE(SUM(a.total_questions),0)::int questions_answered,
         COALESCE(SUM(a.xp_awarded),0)::int gameplay_xp,
         MAX(a.created_at) last_played
         FROM gameplay_attempts a WHERE a.user_id=$1`,
        [user.id],
      ),
      pool.query(
        `SELECT a.id,a.score_percent,a.correct_answers,a.total_questions,a.passed,a.life_lost,
         a.lives_after,a.xp_awarded,a.created_at,l.name level_name,l.level_number,
         c.name category_name,g.name age_group_name
         FROM gameplay_attempts a
         JOIN game_levels l ON l.id=a.level_id
         JOIN game_categories c ON c.id=l.category_id
         JOIN age_groups g ON g.id=c.age_group_id
         WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 10`,
        [user.id],
      ),
      pool.query(
        `SELECT t.id,t.type,t.amount,t.balance_after,t.description,t.reference,t.created_at,
         p.name package_name FROM coin_transactions t
         LEFT JOIN coin_packages p ON p.id=t.package_id
         WHERE t.user_id=$1 ORDER BY t.created_at DESC LIMIT 10`,
        [user.id],
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status='completed')::int completed_purchases,
         COUNT(*) FILTER (WHERE status='pending')::int pending_purchases,
         COALESCE(SUM(amount_minor) FILTER (WHERE status='completed' AND currency='NGN'),0)::bigint spent_minor,
         COALESCE(SUM(coins) FILTER (WHERE status='completed'),0)::bigint purchased_coins
         FROM coin_purchase_intents WHERE user_id=$1`,
        [user.id],
      ),
      pool.query(
        `SELECT b.id,b.name,b.description,b.tier,b.criteria_type,b.criteria_value,ub.earned_at
         FROM user_badges ub JOIN badges b ON b.id=ub.badge_id
         WHERE ub.user_id=$1 ORDER BY ub.earned_at DESC`,
        [user.id],
      ),
    ]);
    return res.json({
      success: true,
      user: {
        ...user,
        performance: performance.rows[0],
        purchases: purchases.rows[0],
      },
      recentAttempts: attempts.rows,
      recentCoinTransactions: coinTransactions.rows,
      earnedBadges: earnedBadges.rows,
    });
  } catch (error) {
    console.error("Admin user profile failed", { userId, error });
    return res.status(500).json({ success: false, message: "User profile could not be loaded." });
  }
});

router.get("/admin/activities", verifyAdminToken, async (req, res) => {
  const parsedLimit = Number.parseInt(String(req.query.limit || "20"), 10);
  const parsedPage = Number.parseInt(String(req.query.page || "1"), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 20;
  const page = Number.isFinite(parsedPage) ? Math.max(parsedPage, 1) : 1;
  try {
    const [activities, total] = await Promise.all([
      pool.query(
        `SELECT id,event_type,title,description,actor_id,actor_name,metadata,created_at
         FROM activity_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, (page - 1) * limit],
      ),
      pool.query("SELECT COUNT(*)::int AS count FROM activity_logs"),
    ]);
    const count = total.rows[0]?.count || 0;
    return res.json({ success: true, activities: activities.rows, pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) } });
  } catch (error) {
    console.error("Admin activity listing failed", error);
    return res.status(500).json({ success: false, message: "Activities could not be loaded." });
  }
});

const adminPermissions = ["dashboard","user-management","content","leaderboard","coin-system","daily-rewards","categories","notifications","settings","admins"] as const;
const createAdminSchema = z.object({
  name: z.string().trim().min(2).max(120), email: z.string().trim().email(),
  password: z.string().min(10).max(128), title: z.string().trim().min(2).max(80),
  permissions: z.array(z.enum(adminPermissions)).min(1),
});
const updateAdminSchema = createAdminSchema.omit({ password: true });
const adminProfileSchema = z.object({ name: z.string().trim().min(2).max(120), title: z.string().trim().min(2).max(80) });
const ensureSuperAdmin = (req: AuthenticatedRequest, res: any) => {
  if (req.user?.role !== "super_admin" || req.user.id !== "super-admin") {
    res.status(403).json({ success: false, message: "Only the Super Admin can manage administrator accounts." });
    return false;
  }
  return true;
};

router.get("/admin/admins", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  if (!ensureSuperAdmin(req, res)) return;
  const result = await pool.query(`SELECT id,name,email,admin_title title,admin_permissions permissions,is_active,created_at
    FROM users WHERE role='admin' ORDER BY created_at DESC`);
  return res.json({ success: true, admins: [
    { id: "super-admin", name: "Super Admin", email: env.SUPER_ADMIN_EMAIL, title: "Super Admin", permissions: ["*"], is_active: true },
    ...result.rows,
  ] });
});

router.post("/admin/admins", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  if (!ensureSuperAdmin(req, res)) return;
  const parsed = createAdminSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Invalid administrator details." });
  const d = parsed.data;
  try {
    const result = await pool.query(`INSERT INTO users(name,username,email,password,role,is_verified,is_active,admin_title,admin_permissions)
      VALUES($1,$2,$3,$4,'admin',true,true,$5,$6) RETURNING id,name,email,admin_title title,admin_permissions permissions,is_active,created_at`,
      [d.name, `admin_${crypto.randomUUID().slice(0,8)}`, normalizeEmail(d.email), await hashPassword(d.password), d.title, JSON.stringify([...new Set(d.permissions)])]);
    await logActivity({ eventType: "admin.created", title: "Administrator created", description: `${d.name} was granted dashboard access`, actorName: "Super Admin", metadata: { adminId: result.rows[0].id } });
    return res.status(201).json({ success: true, admin: result.rows[0] });
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "An account with that email already exists." });
    throw error;
  }
});

router.patch("/admin/admins/:id/status", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  if (!ensureSuperAdmin(req, res)) return;
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "A valid account status is required." });
  const result = await pool.query(`UPDATE users SET is_active=$1,token_version=CASE WHEN $1 THEN token_version ELSE token_version+1 END,updated_at=NOW()
    WHERE id=$2 AND role='admin' RETURNING id,name,is_active`, [parsed.data.isActive, req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Administrator not found." });
  return res.json({ success: true, message: parsed.data.isActive ? "Administrator reactivated." : "Administrator access revoked.", admin: result.rows[0] });
});

router.patch("/admin/admins/:id", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  if (!ensureSuperAdmin(req, res)) return;
  const parsed = updateAdminSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Invalid administrator details." });
  const d = parsed.data;
  try {
    const result = await pool.query(`UPDATE users SET name=$1,email=$2,admin_title=$3,admin_permissions=$4,updated_at=NOW()
      WHERE id=$5 AND role='admin' RETURNING id,name,email,admin_title title,admin_permissions permissions,is_active,created_at`,
      [d.name, normalizeEmail(d.email), d.title, JSON.stringify([...new Set(d.permissions)]), req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Administrator not found." });
    return res.json({ success: true, message: "Administrator updated.", admin: result.rows[0] });
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "An account with that email already exists." });
    throw error;
  }
});

router.get("/admin/account", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  if (req.user!.role === "super_admin") return res.json({ success: true, account: { id: "super-admin", name: "Super Admin", email: env.SUPER_ADMIN_EMAIL, title: "Super Admin", permissions: ["*"], managedByEnvironment: true } });
  const result = await pool.query("SELECT id,name,email,admin_title title,admin_permissions permissions,created_at,updated_at FROM users WHERE id=$1 AND role='admin'", [req.user!.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Administrator account not found." });
  return res.json({ success: true, account: result.rows[0] });
});

router.patch("/admin/account", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  if (req.user!.role === "super_admin") return res.status(409).json({ success: false, message: "The Super Admin profile is managed through backend environment settings." });
  const parsed = adminProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Invalid profile details." });
  const result = await pool.query("UPDATE users SET name=$1,admin_title=$2,updated_at=NOW() WHERE id=$3 AND role='admin' RETURNING id,name,email,admin_title title,admin_permissions permissions,updated_at", [parsed.data.name, parsed.data.title, req.user!.id]);
  return res.json({ success: true, message: "Admin profile updated.", account: result.rows[0] });
});

router.post("/admin/account/password", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  if (req.user!.role === "super_admin") return res.status(409).json({ success: false, message: "Change the Super Admin password through SUPER_ADMIN_PASSWORD in the backend environment." });
  const parsed = UpdatePassword.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Invalid password details." });
  const current = await pool.query("SELECT password FROM users WHERE id=$1 AND role='admin'", [req.user!.id]);
  if (!current.rows[0]?.password || !(await comparePassword(parsed.data.currentPassword, current.rows[0].password))) return res.status(401).json({ success: false, message: "Current password is incorrect." });
  await pool.query("UPDATE users SET password=$1,token_version=token_version+1,updated_at=NOW() WHERE id=$2", [await hashPassword(parsed.data.newPassword), req.user!.id]);
  return res.json({ success: true, message: "Password updated. Please sign in again." });
});

router.get("/user/profile", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  try {
    const [userResult, performance, badges, attempts] = await Promise.all([
      pool.query(`SELECT id,name,username,email,age,total_xp,coins_count,lives_remaining,is_verified,is_oauth,created_at,updated_at FROM users WHERE id=$1 AND role='user'`,[req.user!.id]),
      pool.query(`SELECT COUNT(a.id)::int attempts,COUNT(a.id) FILTER(WHERE a.passed)::int passed_attempts,
        COUNT(DISTINCT a.level_id) FILTER(WHERE a.passed)::int completed_levels,
        COALESCE(ROUND(AVG(a.score_percent)),0)::int average_score,COALESCE(MAX(a.score_percent),0)::int best_score,
        COALESCE(SUM(a.correct_answers),0)::int correct_answers,COALESCE(SUM(a.total_questions),0)::int questions_answered,
        MAX(a.created_at) last_played FROM gameplay_attempts a WHERE a.user_id=$1`,[req.user!.id]),
      pool.query(`SELECT b.id,b.name,b.description,b.tier,b.criteria_type,b.criteria_value,b.sort_order,
        ub.earned_at,(ub.user_id IS NOT NULL) earned FROM badges b
        LEFT JOIN user_badges ub ON ub.badge_id=b.id AND ub.user_id=$1
        WHERE b.is_active=true ORDER BY b.sort_order,b.name`,[req.user!.id]),
      pool.query(`SELECT a.id,a.score_percent,a.correct_answers,a.total_questions,a.passed,a.xp_awarded,a.created_at,
        l.name level_name,l.level_number,c.name category_name,g.name age_group_name
        FROM gameplay_attempts a JOIN game_levels l ON l.id=a.level_id
        JOIN game_categories c ON c.id=l.category_id JOIN age_groups g ON g.id=c.age_group_id
        WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 6`,[req.user!.id]),
    ]);
    if(!userResult.rows[0])return res.status(404).json({success:false,message:"Profile not found."});
    return res.json({success:true,user:{...userResult.rows[0],performance:performance.rows[0]},badges:badges.rows,recentAttempts:attempts.rows});
  } catch(error) {
    console.error("Player profile failed",{userId:req.user!.id,error});
    return res.status(500).json({success:false,message:"Your profile could not be loaded."});
  }
});

router.patch("/user/profile", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const validation=UpdateProfileSchema.safeParse(req.body);
  if(!validation.success)return res.status(400).json({success:false,errors:validation.error.issues});
  const d=validation.data;
  try {
    const result=await pool.query(`UPDATE users SET name=$1,username=$2,age=$3,updated_at=NOW()
      WHERE id=$4 AND role='user' RETURNING id,name,username,email,age,total_xp,coins_count,lives_remaining,is_verified,is_oauth,created_at,updated_at`,
      [d.name,d.username,d.age,req.user!.id]);
    await logActivity({eventType:"user.profile_updated",title:"Profile updated",description:`${d.name} updated their player profile`,actorId:req.user!.id,actorName:d.name});
    return res.json({success:true,message:"Profile updated successfully.",user:result.rows[0]});
  } catch(error:any) {
    if(error.code==="23505")return res.status(409).json({success:false,message:"That username is already in use."});
    console.error("Player profile update failed",{userId:req.user!.id,error});
    return res.status(500).json({success:false,message:"Your profile could not be updated."});
  }
});

router.post("/user/register", sensitiveLimiter, async (req, res) => {
  const validation = RegisterUserSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, errors: validation.error.issues });
  const { name, password, age } = validation.data;
  const email = normalizeEmail(validation.data.email);
  const username = validation.data.username.trim().toLowerCase();
  const otp = generateOtp();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hashedPassword = await hashPassword(password);
    const user = await client.query(
      `INSERT INTO users (name, username, email, password, age, is_verified)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,username,email,role,is_verified`,
      [name.trim(), username, email, hashedPassword, age, !env.EMAIL_VERIFICATION_ENABLED],
    );
    if (env.EMAIL_VERIFICATION_ENABLED) {
      await client.query(
        `INSERT INTO otps(email,otp_code,purpose,expires_at) VALUES($1,$2,'register',NOW()+INTERVAL '15 minutes')
         ON CONFLICT(email,purpose) DO UPDATE SET otp_code=EXCLUDED.otp_code,expires_at=EXCLUDED.expires_at,is_used=false,failed_attempts=0,created_at=NOW()`,
        [email, hashOtp(email, "register", otp)],
      );
      await SendOtp(email, otp);
    }
    await client.query("COMMIT");
    await logActivity({
      eventType: "user.registered",
      title: "New user registered",
      description: `${user.rows[0].name} joined the platform`,
      actorId: user.rows[0].id,
      actorName: user.rows[0].name,
      metadata: { username: user.rows[0].username, verificationRequired: env.EMAIL_VERIFICATION_ENABLED },
    });
    return res.status(201).json({
      success: true,
      requiresVerification: env.EMAIL_VERIFICATION_ENABLED,
      message: env.EMAIL_VERIFICATION_ENABLED
        ? "Registration successful. Please verify your email."
        : "Registration successful. You can now sign in.",
      user: user.rows[0],
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") return res.status(409).json({ success: false, message: "Email or username is already registered." });
    console.error("Registration failed", error);
    return res.status(500).json({ success: false, message: "Registration could not be completed." });
  } finally { client.release(); }
});

router.post("/login", sensitiveLimiter, async (req, res) => {
  const validation = LoginSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, errors: validation.error.issues });
  const email = normalizeEmail(validation.data.email);
  try {
    const result = await pool.query("SELECT id,name,username,email,password,role,is_verified,token_version FROM users WHERE lower(email)=$1", [email]);
    const user = result.rows[0];
    const matches = user?.password ? await comparePassword(validation.data.password, user.password) : false;
    if (!matches) return res.status(401).json({ success: false, message: "Invalid email or password." });
    if (!user.is_verified) return res.status(403).json({ success: false, message: "Verify your email before signing in." });
    await logActivity({ eventType: "user.signed_in", title: "User signed in", description: `${user.name} signed in`, actorId: user.id, actorName: user.name });
    return res.json({ success: true, message: "Sign in successful.", token: signSession(user), user: { id: user.id, name: user.name, username: user.username, email: user.email, role: user.role } });
  } catch (error) {
    console.error("Login failed", error);
    return res.status(500).json({ success: false, message: "Sign in could not be completed." });
  }
});

router.post("/google", sensitiveLimiter, async (req, res, next) => {
  const validation = GoogleAuthSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, errors: validation.error.issues });
  if (!env.GOOGLE_CLIENT_ID) return res.status(503).json({ success: false, message: "Google authentication is not configured." });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: validation.data.idToken, audience: env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified) return res.status(400).json({ success: false, message: "Google email is not verified." });
    const email = normalizeEmail(payload.email);
    const base = email.split("@")[0]!.replace(/[^a-z0-9_]/g, "").slice(0, 25) || "player";
    const username = `${base}_${crypto.randomUUID().slice(0, 8)}`;
    const result = await pool.query(
      `INSERT INTO users(name,username,email,role,is_oauth,is_verified) VALUES($1,$2,$3,'user',true,true)
       ON CONFLICT((lower(email))) DO UPDATE SET name=EXCLUDED.name,is_oauth=true,is_verified=true,updated_at=NOW()
       RETURNING id,name,username,email,role,token_version`,
      [payload.name || base, username, email],
    );
    const user = result.rows[0];
    await logActivity({ eventType: "user.google_authenticated", title: "Google authentication", description: `${user.name} authenticated with Google`, actorId: user.id, actorName: user.name });
    return res.json({ success: true, message: "Google authentication successful.", token: signSession(user), user });
  } catch (error) { next(error); }
});

async function issueOtp(emailValue: string, purpose: "register" | "password_reset") {
  const email = normalizeEmail(emailValue);
  const user = await pool.query("SELECT id,is_verified FROM users WHERE lower(email)=$1", [email]);
  if (!user.rows[0]) return;
  if (purpose === "register" && user.rows[0].is_verified) return;
  const otp = generateOtp();
  await pool.query(
    `INSERT INTO otps(email,otp_code,purpose,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '15 minutes')
     ON CONFLICT(email,purpose) DO UPDATE SET otp_code=EXCLUDED.otp_code,expires_at=EXCLUDED.expires_at,is_used=false,failed_attempts=0,created_at=NOW()`,
    [email, hashOtp(email, purpose, otp), purpose],
  );
  await SendOtp(email, otp);
}

router.post("/forgot-password", sensitiveLimiter, async (req, res) => {
  const validation = ForgotPasswordSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, errors: validation.error.issues });
  try { await issueOtp(validation.data.email, "password_reset"); }
  catch (error) { console.error("Password OTP failed", error); }
  return res.json({ success: true, message: "If the account exists, an OTP has been sent." });
});

router.post("/resend-otp", sensitiveLimiter, async (req, res) => {
  const validation = ResendOtpSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, errors: validation.error.issues });
  try { await issueOtp(validation.data.email, validation.data.purpose); }
  catch (error) { console.error("OTP resend failed", error); }
  return res.json({ success: true, message: "If the account exists, a new OTP has been sent." });
});

router.post("/verify-otp", sensitiveLimiter, async (req, res) => {
  const validation = VerifyOtpSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, errors: validation.error.issues });
  const { otp, purpose } = validation.data;
  const email = normalizeEmail(validation.data.email);
  const expected = hashOtp(email, purpose, otp);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT id FROM otps WHERE email=$1 AND purpose=$2 AND otp_code=$3 AND is_used=false
       AND failed_attempts<5 AND expires_at>NOW() FOR UPDATE`, [email, purpose, expected],
    );
    if (!result.rows[0]) {
      await client.query("UPDATE otps SET failed_attempts=failed_attempts+1 WHERE email=$1 AND purpose=$2 AND is_used=false", [email, purpose]);
      await client.query("COMMIT");
      return res.status(400).json({ success: false, message: "Invalid or expired verification code." });
    }
    if (purpose === "register") {
      await client.query("UPDATE users SET is_verified=true,updated_at=NOW() WHERE lower(email)=$1", [email]);
      await client.query("UPDATE otps SET is_used=true WHERE id=$1", [result.rows[0].id]);
      await client.query("COMMIT");
      return res.json({ success: true, message: "Account verified successfully. You can now log in." });
    }
    const resetToken = jwt.sign({ email, target: "recovery", otpId: result.rows[0].id }, env.JWT_SECRET, {
      expiresIn: "15m", issuer: "cedugames-api", audience: "cedugames-recovery",
    });
    await client.query("COMMIT");
    return res.json({ success: true, message: "OTP verified successfully.", resetToken });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.post("/reset-password", sensitiveLimiter, async (req, res) => {
  const validation = ResetPasswordSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, errors: validation.error.issues });
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  if (!token) return res.status(401).json({ success: false, message: "Missing recovery session token." });
  const client = await pool.connect();
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { issuer: "cedugames-api", audience: "cedugames-recovery" }) as { email: string; target: string; otpId: string };
    if (decoded.target !== "recovery") return res.status(403).json({ success: false, message: "Invalid recovery token." });
    await client.query("BEGIN");
    const consumed = await client.query("UPDATE otps SET is_used=true WHERE id=$1 AND email=$2 AND is_used=false AND expires_at>NOW() RETURNING id", [decoded.otpId, decoded.email]);
    if (!consumed.rows[0]) { await client.query("ROLLBACK"); return res.status(403).json({ success: false, message: "Recovery token was already used or expired." }); }
    await client.query("UPDATE users SET password=$1,token_version=token_version+1,updated_at=NOW() WHERE lower(email)=$2", [await hashPassword(validation.data.newPassword), decoded.email]);
    await client.query("COMMIT");
    return res.json({ success: true, message: "Password reset successful. You can now log in." });
  } catch { await client.query("ROLLBACK"); return res.status(403).json({ success: false, message: "Invalid or expired recovery token." }); }
  finally { client.release(); }
});

router.post("/update-password", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const validation = UpdatePassword.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, errors: validation.error.issues });
  const user = await pool.query("SELECT password FROM users WHERE id=$1", [req.user!.id]);
  if (!user.rows[0]?.password || !(await comparePassword(validation.data.currentPassword, user.rows[0].password))) return res.status(401).json({ success: false, message: "Current password is incorrect." });
  await pool.query("UPDATE users SET password=$1,token_version=token_version+1,updated_at=NOW() WHERE id=$2", [await hashPassword(validation.data.newPassword), req.user!.id]);
  return res.json({ success: true, message: "Password updated successfully. Sign in again on other devices." });
});

export default router;
