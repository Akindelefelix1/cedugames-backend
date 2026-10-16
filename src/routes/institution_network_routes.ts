import { Router } from "express";
import { z } from "zod";
import pool from "../config/database_connection";
import { verifyPlayerToken, type AuthenticatedRequest } from "../middlewares/authentication_middleware";
import { verifyInstitutionToken, type InstitutionRequest } from "../middlewares/institution_authentication_middleware";
import { logActivity } from "../helpers/activityLog";

const router = Router();
const JoinSchema = z.object({ inviteCode: z.string().trim().max(20).optional().or(z.literal("")) });
const StatusSchema = z.object({ status: z.enum(["active", "rejected"]) });
const institutionShape = (row: any) => ({ id: row.id, name: row.name, institutionType: row.institution_type, city: row.city, state: row.state, country: row.country, address: row.address, isPublic: row.is_public });

router.get("/public", async (_req, res) => {
  const result = await pool.query(
    `SELECT id,name,institution_type,address,city,state,country,is_public
     FROM institutions WHERE is_active=true AND is_public=true ORDER BY name LIMIT 100`,
  );
  return res.json({ success: true, institutions: result.rows.map(institutionShape) });
});

router.get("/code/:code", async (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  if (!/^CEDU-[A-Z0-9]{8}$/.test(code)) return res.status(400).json({ success: false, message: "Enter a valid institution code." });
  const result = await pool.query(
    `SELECT id,name,institution_type,address,city,state,country,is_public
     FROM institutions WHERE is_active=true AND upper(invite_code)=$1`, [code],
  );
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "No institution was found for that code." });
  return res.json({ success: true, institution: institutionShape(result.rows[0]) });
});

router.post("/:id/join-requests", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const parsed = JoinSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter a valid institution code." });
  const accountId = req.user!.accountId || req.user!.id;
  const institution = await pool.query("SELECT id,name,is_public,invite_code FROM institutions WHERE id=$1 AND is_active=true", [req.params.id]);
  if (!institution.rows[0]) return res.status(404).json({ success: false, message: "Institution not found." });
  const target = institution.rows[0];
  const suppliedCode = String(parsed.data.inviteCode || "").trim().toUpperCase();
  if (!target.is_public && suppliedCode !== target.invite_code) return res.status(403).json({ success: false, message: "This institution is invite-only. Enter its correct invitation code." });
  const source = suppliedCode ? "invite_code" : "public";
  try {
    const existing = await pool.query("SELECT id,status FROM institution_memberships WHERE institution_id=$1 AND user_id=$2", [target.id, accountId]);
    if (existing.rows[0]?.status === "active") return res.status(409).json({ success: false, message: "This account already belongs to the institution." });
    if (existing.rows[0]?.status === "pending") return res.status(409).json({ success: false, message: "Your request is already waiting for institution approval." });
    const membership = existing.rows[0]
      ? await pool.query("UPDATE institution_memberships SET status='pending',source=$1,requested_at=NOW(),approved_at=NULL,updated_at=NOW() WHERE id=$2 RETURNING id,status,requested_at", [source, existing.rows[0].id])
      : await pool.query("INSERT INTO institution_memberships(institution_id,user_id,status,source) VALUES($1,$2,'pending',$3) RETURNING id,status,requested_at", [target.id, accountId, source]);
    await logActivity({ eventType: "institution.join_requested", title: "Institution join request", description: `A player requested to join ${target.name}`, actorId: accountId, metadata: { institutionId: target.id, membershipId: membership.rows[0].id, source } });
    return res.status(201).json({ success: true, message: `Your request to join ${target.name} has been sent.`, membership: { ...membership.rows[0], institution: institutionShape(target) } });
  } catch (error) {
    console.error("Institution join request failed", error);
    return res.status(500).json({ success: false, message: "Your join request could not be submitted." });
  }
});

router.get("/my-memberships", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const accountId = req.user!.accountId || req.user!.id;
  const result = await pool.query(
    `SELECT m.id,m.status,m.source,m.requested_at,m.approved_at,i.id institution_id,i.name,i.institution_type,i.city,i.state,i.country
     FROM institution_memberships m JOIN institutions i ON i.id=m.institution_id
     WHERE m.user_id=$1 ORDER BY m.requested_at DESC`, [accountId],
  );
  return res.json({ success: true, memberships: result.rows });
});

router.get("/requests", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const result = await pool.query(
    `SELECT m.id,m.status,m.source,m.requested_at,m.approved_at,u.id user_id,u.name,u.username,u.email
     FROM institution_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.institution_id=$1 ORDER BY CASE WHEN m.status='pending' THEN 0 ELSE 1 END,m.requested_at DESC`, [req.institution!.id],
  );
  return res.json({ success: true, requests: result.rows });
});

router.patch("/requests/:id", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = StatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Choose whether to approve or reject this request." });
  const result = await pool.query(
    `UPDATE institution_memberships SET status=$1,approved_at=CASE WHEN $1='active' THEN NOW() ELSE NULL END,updated_at=NOW()
     WHERE id=$2 AND institution_id=$3 RETURNING id,status,approved_at`, [parsed.data.status, req.params.id, req.institution!.id],
  );
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Join request not found." });
  return res.json({ success: true, message: parsed.data.status === "active" ? "Member approved." : "Join request rejected.", membership: result.rows[0] });
});

export default router;
