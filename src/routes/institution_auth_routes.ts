import { Router } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import pool from "../config/database_connection";
import { env } from "../config/env";
import { comparePassword, hashPassword } from "../helpers/hashPassword";
import { destroyMediaQuietly, uploadMedia } from "../services/cloudinary_media_service";
import { SendInstitutionStaffInvitation, SendOtp } from "../helpers/Mailer";
import { generateOtp, hashOtp } from "../helpers/otp";
import { InstitutionLoginSchema, InstitutionRegisterSchema } from "../schemas/institution_auth_schema";
import { verifyInstitutionToken, type InstitutionRequest } from "../middlewares/institution_authentication_middleware";

const router = Router();
const sensitiveLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false });
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, done) => imageTypes.has(file.mimetype)
    ? done(null, true)
    : done(new Error("Choose a JPEG, PNG, GIF, or WebP logo.")),
});
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const signSession = (account: { id: string; token_version: number }) => jwt.sign(
  { id: account.id, role: "institution_owner", ver: account.token_version }, env.JWT_SECRET,
  { expiresIn: "24h", issuer: "cedugames-api", audience: "cedugames-institution" },
);
const accountShape = (row: any) => ({ id: row.id, institutionName: row.name, institutionType: row.institution_type, ownerName: row.owner_name, email: row.email, phone: row.phone, address: row.address, city: row.city, state: row.state, country: row.country, logoUrl: row.logo_url || null, publicAccess: row.is_public, inviteCode: row.invite_code, role: "institution_owner", createdAt: row.created_at });
const signStaffSession = (institutionId: string, staffId: string, tokenVersion: number) => jwt.sign(
  { id: institutionId, role: "institution_staff", staffId, ver: tokenVersion }, env.JWT_SECRET,
  { expiresIn: "24h", issuer: "cedugames-api", audience: "cedugames-institution" },
);
const StaffRoleSchema = z.enum(["teacher", "content_manager", "viewer"]);
const ownerOnly = (req: InstitutionRequest, res: any): boolean => {
  if (req.institution?.role === "institution_owner") return true;
  res.status(403).json({ success: false, message: "Only the institution owner can manage staff." });
  return false;
};

router.get("/staff", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  if (!ownerOnly(req, res)) return;
  const result = await pool.query("SELECT id,email,name,role,status,created_at,updated_at FROM institution_staff WHERE institution_id=$1 ORDER BY created_at DESC", [req.institution!.id]);
  return res.json({ success: true, staff: result.rows });
});

router.post("/staff", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  if (!ownerOnly(req, res)) return;
  const email = normalizeEmail(String(req.body?.email || ""));
  const roleResult = StaffRoleSchema.safeParse(req.body?.role || "teacher");
  if (!/^\S+@\S+\.\S+$/.test(email) || !roleResult.success) return res.status(400).json({ success: false, message: "Enter a valid staff email and role." });
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  let inviteId = "";
  let institutionName = "";
  try {
    const [owner, staff] = await Promise.all([
      pool.query("SELECT id,name FROM institutions WHERE lower(email)=$1", [email]),
      pool.query("SELECT id,status FROM institution_staff WHERE lower(email)=$1", [email]),
    ]);
    if (owner.rows.length || staff.rows.some((item: any) => item.status === "active")) return res.status(409).json({ success: false, message: "That email already belongs to an institution account or active staff member." });
    const institution = await pool.query("SELECT name FROM institutions WHERE id=$1 AND is_active=true", [req.institution!.id]);
    if (!institution.rows[0]) return res.status(404).json({ success: false, message: "Institution account not found." });
    institutionName = institution.rows[0].name;
    const saved = await pool.query(
      `INSERT INTO institution_staff(institution_id,email,role,status,invitation_token_hash,invitation_expires_at)
       VALUES($1,$2,$3,'pending',$4,NOW()+INTERVAL '7 days')
       ON CONFLICT(institution_id,email) DO UPDATE SET role=EXCLUDED.role,status='pending',invitation_token_hash=EXCLUDED.invitation_token_hash,invitation_expires_at=EXCLUDED.invitation_expires_at,updated_at=NOW()
       WHERE institution_staff.status<>'active'
       RETURNING id`, [req.institution!.id, email, roleResult.data, tokenHash],
    );
    if (!saved.rows[0]) return res.status(409).json({ success: false, message: "This staff member is already active." });
    inviteId = saved.rows[0].id;
    const inviteLink = `${env.INSTITUTION_APP_URL}/staff-invitation?token=${encodeURIComponent(token)}`;
    await SendInstitutionStaffInvitation(email, institutionName, roleResult.data, inviteLink);
    return res.status(201).json({ success: true, message: "Staff invitation sent.", invitation: { id: inviteId, email, role: roleResult.data, status: "pending" } });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ success: false, message: "That email is already assigned to another institution staff account." });
    if (inviteId) await pool.query("DELETE FROM institution_staff WHERE id=$1 AND status='pending'", [inviteId]).catch(() => undefined);
    console.error("Institution staff invitation failed", error);
    return res.status(502).json({ success: false, message: "The staff invitation could not be sent. Check email delivery settings and try again." });
  }
});

router.patch("/staff/:id", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  if (!ownerOnly(req, res)) return;
  const role = StaffRoleSchema.safeParse(req.body?.role);
  if (!role.success) return res.status(400).json({ success: false, message: "Choose a valid staff role." });
  const result = await pool.query("UPDATE institution_staff SET role=$1,updated_at=NOW() WHERE id=$2 AND institution_id=$3 AND status IN ('pending','active') RETURNING id,email,name,role,status,updated_at", [role.data, req.params.id, req.institution!.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Staff member not found." });
  return res.json({ success: true, message: "Staff role updated.", staff: result.rows[0] });
});

router.delete("/staff/:id", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  if (!ownerOnly(req, res)) return;
  const result = await pool.query("UPDATE institution_staff SET status='revoked',password=NULL,invitation_token_hash=NULL,token_version=token_version+1,updated_at=NOW() WHERE id=$1 AND institution_id=$2 AND status<>'revoked' RETURNING id", [req.params.id, req.institution!.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Staff member not found." });
  return res.json({ success: true, message: "Staff access revoked." });
});

router.post("/staff-invitations/accept", sensitiveLimiter, async (req, res) => {
  const token = String(req.body?.token || "");
  const name = String(req.body?.name || "").trim();
  const password = String(req.body?.password || "");
  if (token.length < 32 || name.length < 2 || name.length > 160 || password.length < 10 || password.length > 128) return res.status(400).json({ success: false, message: "Enter your name and a password with at least 10 characters." });
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  try {
    const result = await pool.query(
      `UPDATE institution_staff s SET name=$1,password=$2,status='active',invitation_token_hash=NULL,invitation_expires_at=NULL,token_version=token_version+1,updated_at=NOW()
       FROM institutions i WHERE s.institution_id=i.id AND s.invitation_token_hash=$3 AND s.status='pending' AND s.invitation_expires_at>NOW() AND i.is_active=true
       RETURNING s.id,s.institution_id,s.email,s.name,s.role,s.token_version,i.name institution_name,i.institution_type,i.owner_name,i.phone,i.address,i.city,i.state,i.country,i.logo_url,i.is_public,i.invite_code,i.created_at` ,
      [name, await hashPassword(password), tokenHash],
    );
    const staff = result.rows[0];
    if (!staff) return res.status(400).json({ success: false, message: "This invitation is invalid or has expired. Ask the institution to send a new one." });
    const account = { ...staff, id: staff.institution_id, name: staff.institution_name, owner_name: staff.name };
    return res.status(201).json({ success: true, message: "Staff account created.", token: signStaffSession(staff.institution_id, staff.id, staff.token_version), account: { ...accountShape(account), email: staff.email, role: staff.role, isStaff: true } });
  } catch (error) {
    console.error("Staff invitation acceptance failed", error);
    return res.status(500).json({ success: false, message: "The staff account could not be created." });
  }
});

const RecoveryEmailSchema = z.object({ email: z.string().trim().email().max(320) });
const RecoveryCodeSchema = RecoveryEmailSchema.extend({ otp: z.string().regex(/^\d{6}$/) });
const RecoveryPasswordSchema = z.object({ newPassword: z.string().min(8).max(128) });
const INSTITUTION_RESET_PURPOSE = "institution_password_reset" as const;

router.post("/forgot-password", sensitiveLimiter, async (req, res) => {
  const input = RecoveryEmailSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ success: false, message: "Enter a valid email address." });
  const email = normalizeEmail(input.data.email);
  try {
    const account = await pool.query(
      `SELECT email FROM institutions WHERE lower(email)=$1 AND is_active=true
       UNION ALL SELECT s.email FROM institution_staff s JOIN institutions i ON i.id=s.institution_id WHERE lower(s.email)=$1 AND s.status='active' AND i.is_active=true LIMIT 1`,
      [email],
    );
    if (account.rows[0]) {
      const otp = generateOtp();
      const saved = await pool.query(
        `INSERT INTO otps(email,otp_code,purpose,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '15 minutes')
         ON CONFLICT(email,purpose) DO UPDATE SET otp_code=EXCLUDED.otp_code,expires_at=EXCLUDED.expires_at,is_used=false,failed_attempts=0,created_at=NOW()
         WHERE otps.created_at <= NOW()-INTERVAL '60 seconds' RETURNING id`,
        [email, hashOtp(email, INSTITUTION_RESET_PURPOSE, otp), INSTITUTION_RESET_PURPOSE],
      );
      if (saved.rowCount) {
        try {
          await SendOtp(email, otp, "password_reset");
        } catch (error) {
          await pool.query("DELETE FROM otps WHERE id=$1", [saved.rows[0].id]).catch(() => undefined);
          throw error;
        }
      }
    }
  } catch (error) { console.error("Institution password recovery request failed", error); }
  return res.json({ success: true, message: "If the account exists, a recovery code has been sent." });
});

router.post("/verify-reset-code", sensitiveLimiter, async (req, res) => {
  const input = RecoveryCodeSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ success: false, message: "Enter a valid email address and six-digit code." });
  const email = normalizeEmail(input.data.email), client = await pool.connect();
  try {
    await client.query("BEGIN");
    const otp = await client.query(
      `SELECT id FROM otps WHERE email=$1 AND purpose=$2 AND otp_code=$3 AND is_used=false AND failed_attempts<5 AND expires_at>NOW() FOR UPDATE`,
      [email, INSTITUTION_RESET_PURPOSE, hashOtp(email, INSTITUTION_RESET_PURPOSE, input.data.otp)],
    );
    if (!otp.rows[0]) {
      await client.query("UPDATE otps SET failed_attempts=failed_attempts+1 WHERE email=$1 AND purpose=$2 AND is_used=false", [email, INSTITUTION_RESET_PURPOSE]);
      await client.query("COMMIT");
      return res.status(400).json({ success: false, message: "That code is invalid or expired. Request a new code and try again." });
    }
    const resetToken = jwt.sign({ email, target: "institution_recovery", otpId: otp.rows[0].id }, env.JWT_SECRET, {
      expiresIn: "15m", issuer: "cedugames-api", audience: "cedugames-institution-recovery",
    });
    await client.query("COMMIT");
    return res.json({ success: true, message: "Code verified. Choose a new password.", resetToken });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.post("/reset-password", sensitiveLimiter, async (req, res) => {
  const input = RecoveryPasswordSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ success: false, message: "Your new password must contain 8 to 128 characters." });
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  if (!token) return res.status(401).json({ success: false, message: "Verify your recovery code before setting a new password." });
  let decoded: { email: string; target: string; otpId: string };
  try {
    decoded = jwt.verify(token, env.JWT_SECRET, { issuer: "cedugames-api", audience: "cedugames-institution-recovery" }) as typeof decoded;
  } catch { return res.status(403).json({ success: false, message: "Your recovery session expired. Request a new code." }); }
  if (decoded.target !== "institution_recovery") return res.status(403).json({ success: false, message: "Invalid recovery session." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const consumed = await client.query("UPDATE otps SET is_used=true WHERE id=$1 AND email=$2 AND purpose=$3 AND is_used=false AND expires_at>NOW() RETURNING id", [decoded.otpId, decoded.email, INSTITUTION_RESET_PURPOSE]);
    if (!consumed.rows[0]) { await client.query("ROLLBACK"); return res.status(403).json({ success: false, message: "This recovery session was already used or expired. Request a new code." }); }
    const password = await hashPassword(input.data.newPassword);
    const owner = await client.query("UPDATE institutions SET password=$1,token_version=token_version+1,updated_at=NOW() WHERE lower(email)=$2 AND is_active=true RETURNING id", [password, decoded.email]);
    const staff = owner.rows[0] ? { rowCount: 1 } : await client.query(
      `UPDATE institution_staff s SET password=$1,token_version=token_version+1,updated_at=NOW()
       FROM institutions i WHERE s.institution_id=i.id AND lower(s.email)=$2 AND s.status='active' AND i.is_active=true RETURNING s.id`,
      [password, decoded.email],
    );
    if (!owner.rows[0] && !staff.rowCount) { await client.query("ROLLBACK"); return res.status(403).json({ success: false, message: "This account can no longer be recovered." }); }
    await client.query("COMMIT");
    return res.json({ success: true, message: "Password reset successfully. Sign in with your new password." });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.patch("/profile", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const institutionName = String(req.body?.institutionName || "").trim();
  const institutionType = String(req.body?.institutionType || "").trim();
  const email = normalizeEmail(String(req.body?.email || ""));
  const phone = String(req.body?.phone || "").trim();
  const address = String(req.body?.address || "").trim() || null;
  const country = String(req.body?.country || "").trim();
  const location = String(req.body?.location || "").trim();
  if (institutionName.length < 2 || institutionName.length > 160) return res.status(400).json({ success: false, message: "Enter a valid institution name." });
  if (institutionType.length < 2 || institutionType.length > 80) return res.status(400).json({ success: false, message: "Enter a valid institution type." });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, message: "Enter a valid institution email." });
  if (!country || country.length > 100) return res.status(400).json({ success: false, message: "Enter a valid country." });
  const [city, state] = location.split(",").map((part: string) => part.trim()).filter(Boolean);
  try {
    const result = await pool.query(
      `UPDATE institutions SET name=$1,institution_type=$2,email=$3,phone=$4,address=$5,city=$6,state=$7,country=$8,updated_at=NOW()
       WHERE id=$9 AND is_active=true
       RETURNING id,name,institution_type,owner_name,email,phone,address,city,state,country,logo_url,is_public,invite_code,created_at`,
      [institutionName, institutionType, email, phone || null, address, city || null, state || null, country, req.institution!.id],
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Institution account not found." });
    return res.json({ success: true, message: "Institution profile updated.", account: accountShape(result.rows[0]) });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ success: false, message: "An institution account with that email already exists." });
    console.error("Institution profile update failed", error);
    return res.status(500).json({ success: false, message: "Institution profile could not be updated." });
  }
});

router.post("/logo", verifyInstitutionToken, logoUpload.single("image"), async (req: InstitutionRequest, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Choose an image to use as your institution logo." });
  const current = await pool.query("SELECT logo_url FROM institutions WHERE id=$1 AND is_active=true", [req.institution!.id]);
  if (!current.rows[0]) return res.status(404).json({ success: false, message: "Institution account not found." });
  const media = await uploadMedia(req.file, "institution-logos");
  try {
    const result = await pool.query(
      `UPDATE institutions SET logo_url=$1,updated_at=NOW()
       WHERE id=$2 AND is_active=true
       RETURNING id,name,institution_type,owner_name,email,phone,address,city,state,country,logo_url,is_public,invite_code,created_at`,
      [media.url, req.institution!.id],
    );
    if (!result.rows[0]) {
      await destroyMediaQuietly(media);
      return res.status(404).json({ success: false, message: "Institution account not found." });
    }
    await destroyMediaQuietly(current.rows[0].logo_url);
    return res.json({ success: true, message: "Institution logo updated.", account: accountShape(result.rows[0]) });
  } catch (error) {
    await destroyMediaQuietly(media);
    console.error("Institution logo update failed", error);
    return res.status(500).json({ success: false, message: "Institution logo could not be updated." });
  }
});

router.post("/register", sensitiveLimiter, async (req, res) => {
  const validation = InstitutionRegisterSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, message: validation.error.issues[0]?.message || "Enter valid institution details." });
  const data = validation.data;
  try {
    const result = await pool.query(
      `INSERT INTO institutions(name,institution_type,owner_name,email,phone,address,city,state,country,is_public,invite_code,password)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id,name,institution_type,owner_name,email,phone,address,city,state,country,logo_url,is_public,invite_code,token_version,created_at`,
      [data.institutionName, data.institutionType, data.ownerName, normalizeEmail(data.email), data.phone, data.address || null, data.city || null, data.state || null, data.country, data.publicAccess, `CEDU-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`, await hashPassword(data.password)],
    );
    const account = result.rows[0];
    return res.status(201).json({ success: true, message: "Institution workspace created successfully.", token: signSession(account), account: accountShape(account) });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ success: false, message: "An institution account with that email already exists." });
    console.error("Institution registration failed", error);
    return res.status(500).json({ success: false, message: "Institution account could not be created." });
  }
});

router.post("/login", sensitiveLimiter, async (req, res) => {
  const validation = InstitutionLoginSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, message: "Enter a valid email and password." });
  try {
    const result = await pool.query("SELECT id,name,institution_type,owner_name,email,phone,address,city,state,country,logo_url,is_public,invite_code,password,is_active,token_version,created_at FROM institutions WHERE lower(email)=$1", [normalizeEmail(validation.data.email)]);
    const account = result.rows[0];
    if (account) {
      if (!(await comparePassword(validation.data.password, account.password))) return res.status(401).json({ success: false, message: "Invalid institution email or password." });
      if (!account.is_active) return res.status(403).json({ success: false, message: "This institution account has been deactivated." });
      return res.json({ success: true, message: "Institution sign in successful.", token: signSession(account), account: accountShape(account) });
    }
    const staffResult = await pool.query(
      `SELECT s.id staff_id,s.institution_id,s.email staff_email,s.name staff_name,s.role staff_role,s.password staff_password,s.token_version staff_token_version,
              i.id,i.name,i.institution_type,i.owner_name,i.email,i.phone,i.address,i.city,i.state,i.country,i.logo_url,i.is_public,i.invite_code,i.created_at,i.is_active
       FROM institution_staff s JOIN institutions i ON i.id=s.institution_id WHERE lower(s.email)=$1 AND s.status='active'`, [normalizeEmail(validation.data.email)],
    );
    const staff = staffResult.rows[0];
    if (!staff || !staff.is_active || !(await comparePassword(validation.data.password, staff.staff_password))) return res.status(401).json({ success: false, message: "Invalid institution email or password." });
    const shaped = { ...accountShape({ ...staff, owner_name: staff.staff_name }), email: staff.staff_email, ownerName: staff.staff_name, role: staff.staff_role, isStaff: true };
    return res.json({ success: true, message: "Staff sign in successful.", token: signStaffSession(staff.institution_id, staff.staff_id, staff.staff_token_version), account: shaped });
  } catch (error) {
    console.error("Institution login failed", error);
    return res.status(500).json({ success: false, message: "Institution sign in could not be completed." });
  }
});

router.get("/me", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  if (req.institution!.role === "institution_staff") {
    const result = await pool.query(
      `SELECT s.id staff_id,s.email staff_email,s.name staff_name,s.role staff_role,s.token_version staff_token_version,
              i.id,i.name,i.institution_type,i.owner_name,i.email,i.phone,i.address,i.city,i.state,i.country,i.logo_url,i.is_public,i.invite_code,i.created_at
       FROM institution_staff s JOIN institutions i ON i.id=s.institution_id WHERE s.id=$1 AND s.institution_id=$2 AND s.status='active'`, [req.institution!.staffId, req.institution!.id],
    );
    const staff = result.rows[0];
    if (!staff) return res.status(404).json({ success: false, message: "Staff account not found." });
    return res.json({ success: true, account: { ...accountShape({ ...staff, owner_name: staff.staff_name }), email: staff.staff_email, ownerName: staff.staff_name, role: staff.staff_role, isStaff: true } });
  }
  const result = await pool.query("SELECT id,name,institution_type,owner_name,email,phone,address,city,state,country,logo_url,is_public,invite_code,created_at FROM institutions WHERE id=$1 AND is_active=true", [req.institution!.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Institution account not found." });
  return res.json({ success: true, account: accountShape(result.rows[0]) });
});

router.patch("/visibility", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  if (typeof req.body?.publicAccess !== "boolean") return res.status(400).json({ success: false, message: "Choose whether your institution is public or invite-only." });
  try {
    const result = await pool.query(
      "UPDATE institutions SET is_public=$1 WHERE id=$2 AND is_active=true RETURNING id,name,institution_type,owner_name,email,phone,address,city,state,country,logo_url,is_public,invite_code,created_at",
      [req.body.publicAccess, req.institution!.id],
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Institution account not found." });
    return res.json({ success: true, message: result.rows[0].is_public ? "Institution is now public." : "Institution is now invite-only.", account: accountShape(result.rows[0]) });
  } catch (error) {
    console.error("Institution visibility update failed", error);
    return res.status(500).json({ success: false, message: "Institution visibility could not be updated." });
  }
});

export default router;
