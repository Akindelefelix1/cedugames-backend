import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import pool from "../config/database_connection";
import { verifyAdminToken, type AuthenticatedRequest } from "../middlewares/authentication_middleware";
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
const PublishingPolicySchema = z.object({ policy: z.enum(["admin_review", "auto_publish"]) });
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
  status: row.admin_status || (row.is_active ? "Active" : "Suspended"),
  publishing: row.publishing_policy === "auto_publish" ? "Auto-publish" : "Admin review",
  joined: row.created_at,
  initials: row.name.split(/\s+/).map((part: string) => part[0]).join("").slice(0, 2).toUpperCase(),
});
const select = `SELECT i.id,i.name,i.owner_name,i.email,i.phone,i.city,i.state,i.country,i.is_active,i.admin_status,i.created_at,
  COUNT(DISTINCT m.id) FILTER (WHERE m.status='active')::int students,
  COUNT(DISTINCT q.id)::int questions,
  COUNT(DISTINCT q.id) FILTER (WHERE q.status='draft' AND q.review_status='pending')::int question_review,
  COUNT(DISTINCT pending.id)::int pending_requests,
  i.publishing_policy
  FROM institutions i LEFT JOIN institution_memberships m ON m.institution_id=i.id LEFT JOIN institution_memberships pending ON pending.institution_id=i.id AND pending.status='pending' LEFT JOIN institution_questions q ON q.institution_id=i.id`;

router.get("/", verifyAdminToken, async (_req, res) => {
  const result = await pool.query(`${select} GROUP BY i.id ORDER BY i.created_at DESC`);
  return res.json({ success: true, institutions: result.rows.map(shape) });
});

const QuestionReviewSchema = z.object({
  decision: z.enum(["approve", "changes_requested"]),
  notes: z.string().trim().max(1000).default(""),
});

router.get("/questions/review-queue", verifyAdminToken, async (_req, res) => {
  const result = await pool.query(
    `SELECT q.id,q.subject,q.question_text,q.explanation,q.status,q.created_at,q.media_url,q.media_type,
       q.read_aloud,q.shape_type,q.shape_color,q.time_limit_seconds,q.review_notes,
       i.id institution_id,i.name institution_name,l.name level_name,c.name category_name,
       COALESCE(json_agg(json_build_object('text',o.option_text,'isCorrect',o.is_correct,'mediaUrl',o.media_url,'mediaType',o.media_type,'shapeType',o.shape_type,'shapeColor',o.shape_color) ORDER BY o.option_order) FILTER (WHERE o.id IS NOT NULL),'[]') options
     FROM institution_questions q
     JOIN institutions i ON i.id=q.institution_id
     JOIN institution_levels l ON l.id=q.level_id
     JOIN institution_categories c ON c.id=l.category_id
     LEFT JOIN institution_question_options o ON o.question_id=q.id
     WHERE q.status='draft' AND q.review_status='pending'
     GROUP BY q.id,i.id,l.id,c.id
     ORDER BY q.created_at ASC`,
  );
  return res.json({ success: true, questions: result.rows });
});

router.patch("/questions/:questionId/review", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  const id = z.string().uuid().safeParse(req.params.questionId);
  const parsed = QuestionReviewSchema.safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ success: false, message: "Choose a valid review decision." });
  const { decision, notes } = parsed.data;
  const result = await pool.query(
    `UPDATE institution_questions
     SET status=CASE WHEN $2='approve' THEN 'published' ELSE 'draft' END,
         review_status=CASE WHEN $2='approve' THEN 'approved' ELSE 'changes_requested' END,
         review_notes=CASE WHEN $2='approve' THEN '' ELSE $3 END,
         reviewed_at=NOW(),reviewed_by=$4,updated_at=NOW()
     WHERE id=$1 AND status='draft' AND review_status='pending'
     RETURNING id,institution_id,subject,status,review_status`,
    [id.data, decision, notes, req.user?.id === "super-admin" ? null : req.user?.id || null],
  );
  const question = result.rows[0];
  if (!question) return res.status(404).json({ success: false, message: "This question is no longer waiting for review." });
  const decisionText = decision === "approve" ? "approved" : "returned for changes";
  await logActivity({ eventType: `institution.question_${decision === "approve" ? "approved" : "changes_requested"}`, title: `Institution question ${decisionText}`, description: `A question in ${question.subject} was ${decisionText}`, actorId: req.user!.id === "super-admin" ? null : req.user!.id, metadata: { institutionId: question.institution_id, questionId: question.id, reviewStatus: question.review_status } });
  return res.json({ success: true, message: `Question ${decisionText}.`, question });
});

router.patch("/:id/publishing-policy", verifyAdminToken, async (req: AuthenticatedRequest, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const parsed = PublishingPolicySchema.safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ success: false, message: "Choose a valid institution publishing policy." });
  const result = await pool.query(
    "UPDATE institutions SET publishing_policy=$1,updated_at=NOW() WHERE id=$2 RETURNING id,name,publishing_policy",
    [parsed.data.policy, id.data],
  );
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Institution not found." });
  const label = parsed.data.policy === "auto_publish" ? "Auto-publish" : "Admin review";
  await logActivity({ eventType: "institution.publishing_policy_updated", title: "Institution publishing policy updated", description: `${result.rows[0].name} now uses ${label.toLowerCase()}`, actorId: req.user?.id === "super-admin" ? null : req.user?.id || null, metadata: { institutionId: result.rows[0].id, publishingPolicy: parsed.data.policy } });
  return res.json({ success: true, message: `${result.rows[0].name} publishing policy set to ${label}.`, institution: { id: result.rows[0].id, publishing: label } });
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
  const result = await pool.query("UPDATE institutions SET admin_status=$1,is_active=$2,publishing_policy=CASE WHEN $1='Needs review' THEN 'admin_review' ELSE publishing_policy END,updated_at=NOW() WHERE id=$3 RETURNING id,name,owner_name,email,phone,city,state,country,is_active,admin_status,publishing_policy,created_at", [parsed.data.status, active, req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Institution not found." });
  await logActivity({ eventType: "institution.status_updated", title: "Institution status updated", description: `${result.rows[0].name} was marked ${parsed.data.status.toLowerCase()}`, metadata: { institutionId: result.rows[0].id, status: parsed.data.status } });
  return res.json({ success: true, message: `Institution marked ${parsed.data.status.toLowerCase()}.`, institution: shape(result.rows[0]) });
});

export default router;
