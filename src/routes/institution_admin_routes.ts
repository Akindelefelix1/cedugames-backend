import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import pool from "../config/database_connection";
import { verifyAdminToken } from "../middlewares/authentication_middleware";
import { hashPassword } from "../helpers/hashPassword";
import { logActivity } from "../helpers/activityLog";

const router = Router();
const CreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  owner: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
});
const StatusSchema = z.object({ status: z.enum(["Active", "Needs review", "Suspended"]) });
const shape = (row: any) => ({
  id: row.id,
  name: row.name,
  owner: row.owner_name,
  email: row.email,
  phone: row.phone,
  location: [row.city, row.state, row.country].filter(Boolean).join(", ") || "Location not provided",
  students: Number(row.students || 0),
  questions: Number(row.questions || 0),
  questionReview: Number(row.question_review || 0),
  pendingRequests: Number(row.pending_requests || 0),
  staff: Number(row.staff || 0),
  sessions: Number(row.sessions || 0),
  status: row.admin_status || (row.is_active ? "Active" : "Suspended"),
  publishing: row.publishing_policy || "Admin review",
  joined: row.created_at,
  initials: row.name.split(/\s+/).map((part: string) => part[0]).join("").slice(0, 2).toUpperCase(),
});
const select = `SELECT i.id,i.name,i.owner_name,i.email,i.phone,i.city,i.state,i.country,i.is_active,i.admin_status,i.created_at,
  COUNT(DISTINCT m.id) FILTER (WHERE m.status='active')::int students,
  COUNT(DISTINCT q.id)::int questions,
  COUNT(DISTINCT q.id) FILTER (WHERE q.status='draft')::int question_review,
  COUNT(DISTINCT pending.id)::int pending_requests,
  1::int staff,
  0::int sessions,'Admin review' publishing_policy
  FROM institutions i LEFT JOIN institution_memberships m ON m.institution_id=i.id LEFT JOIN institution_memberships pending ON pending.institution_id=i.id AND pending.status='pending' LEFT JOIN institution_questions q ON q.institution_id=i.id`;

router.get("/", verifyAdminToken, async (_req, res) => {
  const result = await pool.query(`${select} GROUP BY i.id ORDER BY i.created_at DESC`);
  return res.json({ success: true, institutions: result.rows.map(shape) });
});

router.get("/:id/activity", verifyAdminToken, async (req, res) => {
  const institution = await pool.query("SELECT id FROM institutions WHERE id=$1", [req.params.id]);
  if (!institution.rows[0]) return res.status(404).json({ success: false, message: "Institution not found." });
  const result = await pool.query(
    `SELECT id,event_type,title,description,actor_name,metadata,created_at
     FROM activity_logs
     WHERE metadata->>'institutionId'=$1
     ORDER BY created_at DESC LIMIT 50`, [req.params.id],
  );
  return res.json({ success: true, activities: result.rows });
});

router.post("/", verifyAdminToken, async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Enter valid institution details." });
  const data = parsed.data;
  try {
    const password = crypto.randomBytes(18).toString("base64url");
    const result = await pool.query(
      `INSERT INTO institutions(name,institution_type,owner_name,email,phone,password,invite_code)
       VALUES($1,'Other',$2,$3,$4,$5,$6)
       RETURNING id,name,owner_name,email,phone,city,state,country,is_active,admin_status,created_at`,
      [data.name, data.owner, data.email.toLowerCase(), data.phone || null, await hashPassword(password), `CEDU-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`],
    );
    await logActivity({ eventType: "institution.created", title: "Institution created", description: `${data.name} institution workspace was created`, metadata: { institutionId: result.rows[0].id } });
    return res.status(201).json({ success: true, message: "Institution setup created.", institution: shape(result.rows[0]), temporaryPassword: password });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ success: false, message: "An institution account with that email already exists." });
    throw error;
  }
});

router.patch("/:id/status", verifyAdminToken, async (req, res) => {
  const parsed = StatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Choose a valid institution status." });
  const active = parsed.data.status !== "Suspended";
  const result = await pool.query("UPDATE institutions SET admin_status=$1,is_active=$2,updated_at=NOW() WHERE id=$3 RETURNING id,name,owner_name,email,phone,city,state,country,is_active,admin_status,created_at", [parsed.data.status, active, req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Institution not found." });
  await logActivity({ eventType: "institution.status_updated", title: "Institution status updated", description: `${result.rows[0].name} was marked ${parsed.data.status.toLowerCase()}`, metadata: { institutionId: result.rows[0].id, status: parsed.data.status } });
  return res.json({ success: true, message: `Institution marked ${parsed.data.status.toLowerCase()}.`, institution: shape(result.rows[0]) });
});

export default router;
