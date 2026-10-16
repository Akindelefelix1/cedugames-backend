import { Router } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import pool from "../config/database_connection";
import { env } from "../config/env";
import { comparePassword, hashPassword } from "../helpers/hashPassword";
import { InstitutionLoginSchema, InstitutionRegisterSchema } from "../schemas/institution_auth_schema";
import { verifyInstitutionToken, type InstitutionRequest } from "../middlewares/institution_authentication_middleware";

const router = Router();
const sensitiveLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false });
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const signSession = (account: { id: string; token_version: number }) => jwt.sign(
  { id: account.id, role: "institution_owner", ver: account.token_version }, env.JWT_SECRET,
  { expiresIn: "24h", issuer: "cedugames-api", audience: "cedugames-institution" },
);
const accountShape = (row: any) => ({ id: row.id, institutionName: row.name, institutionType: row.institution_type, ownerName: row.owner_name, email: row.email, phone: row.phone, address: row.address, city: row.city, state: row.state, country: row.country, publicAccess: row.is_public, inviteCode: row.invite_code, role: "institution_owner", createdAt: row.created_at });

router.post("/register", sensitiveLimiter, async (req, res) => {
  const validation = InstitutionRegisterSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ success: false, message: validation.error.issues[0]?.message || "Enter valid institution details." });
  const data = validation.data;
  try {
    const result = await pool.query(
      `INSERT INTO institutions(name,institution_type,owner_name,email,phone,address,city,state,country,is_public,invite_code,password)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id,name,institution_type,owner_name,email,phone,address,city,state,country,is_public,invite_code,token_version,created_at`,
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
    const result = await pool.query("SELECT id,name,institution_type,owner_name,email,phone,address,city,state,country,is_public,invite_code,password,is_active,token_version,created_at FROM institutions WHERE lower(email)=$1", [normalizeEmail(validation.data.email)]);
    const account = result.rows[0];
    if (!account || !(await comparePassword(validation.data.password, account.password))) return res.status(401).json({ success: false, message: "Invalid institution email or password." });
    if (!account.is_active) return res.status(403).json({ success: false, message: "This institution account has been deactivated." });
    return res.json({ success: true, message: "Institution sign in successful.", token: signSession(account), account: accountShape(account) });
  } catch (error) {
    console.error("Institution login failed", error);
    return res.status(500).json({ success: false, message: "Institution sign in could not be completed." });
  }
});

router.get("/me", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const result = await pool.query("SELECT id,name,institution_type,owner_name,email,phone,address,city,state,country,is_public,invite_code,created_at FROM institutions WHERE id=$1 AND is_active=true", [req.institution!.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Institution account not found." });
  return res.json({ success: true, account: accountShape(result.rows[0]) });
});

export default router;
