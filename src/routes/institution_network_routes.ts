import { Router } from "express";
import { z } from "zod";
import pool from "../config/database_connection";
import { verifyPlayerToken, type AuthenticatedRequest } from "../middlewares/authentication_middleware";
import { verifyInstitutionToken, type InstitutionRequest } from "../middlewares/institution_authentication_middleware";
import { logActivity } from "../helpers/activityLog";

const router = Router();
const JoinSchema = z.object({ inviteCode: z.string().trim().max(20).optional().or(z.literal("")) });
const StatusSchema = z.object({ status: z.enum(["active", "rejected"]) });
const StructureSettingsSchema = z.object({ categoryLabel: z.string().trim().min(2).max(80), levelLabel: z.string().trim().min(2).max(80), learnerLabel: z.string().trim().min(2).max(80), subjectLabel: z.string().trim().min(2).max(80) });
const CategorySchema = z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).default(""), sortOrder: z.coerce.number().int().min(0).max(10000).default(0) });
const LevelSchema = z.object({ categoryId: z.string().uuid(), name: z.string().trim().min(2).max(120), code: z.string().trim().max(80).default(""), learnerCount: z.coerce.number().int().min(0).max(1000000).default(0), subjects: z.array(z.string().trim().min(1).max(120)).max(50).default([]), sortOrder: z.coerce.number().int().min(0).max(10000).default(0) });
const institutionShape = (row: any) => ({ id: row.id, name: row.name, institutionType: row.institution_type, city: row.city, state: row.state, country: row.country, address: row.address, isPublic: row.is_public });
const categoryShape = (row: any) => ({ id: row.id, name: row.name, description: row.description || "", levels: Number(row.level_count || 0), sortOrder: Number(row.sort_order || 0), tone: row.tone || "purple" });
const levelShape = (row: any) => ({ id: row.id, categoryId: row.category_id, category: row.category_name, name: row.name, code: row.code || "", learners: Number(row.learner_count || 0), subjects: Array.isArray(row.subjects) ? row.subjects : [], sortOrder: Number(row.sort_order || 0), status: row.is_active ? "Active" : "Inactive", questions: Number(row.question_count || 0), progress: 0 });

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

router.get("/structure", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const institutionId = req.institution!.id;
  const [settings, categories, levels] = await Promise.all([
    pool.query("SELECT category_label,level_label,learner_label,subject_label FROM institution_structure_settings WHERE institution_id=$1", [institutionId]),
    pool.query("SELECT c.*,COUNT(l.id)::int level_count FROM institution_categories c LEFT JOIN institution_levels l ON l.category_id=c.id AND l.is_active=true WHERE c.institution_id=$1 AND c.is_active=true GROUP BY c.id ORDER BY c.sort_order,c.created_at", [institutionId]),
    pool.query(`SELECT l.*,c.name category_name,0::int question_count FROM institution_levels l JOIN institution_categories c ON c.id=l.category_id WHERE l.institution_id=$1 AND l.is_active=true AND c.is_active=true ORDER BY l.sort_order,l.created_at`, [institutionId]),
  ]);
  return res.json({ success: true, labels: settings.rows[0] ? { category: settings.rows[0].category_label, level: settings.rows[0].level_label, learner: settings.rows[0].learner_label, subject: settings.rows[0].subject_label } : { category: "Section", level: "Class", learner: "Learners", subject: "Learning areas" }, categories: categories.rows.map(categoryShape), levels: levels.rows.map(levelShape) });
});

router.put("/structure/settings", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = StructureSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter valid names for each structure label." });
  const d = parsed.data;
  const result = await pool.query(`INSERT INTO institution_structure_settings(institution_id,category_label,level_label,learner_label,subject_label) VALUES($1,$2,$3,$4,$5) ON CONFLICT(institution_id) DO UPDATE SET category_label=EXCLUDED.category_label,level_label=EXCLUDED.level_label,learner_label=EXCLUDED.learner_label,subject_label=EXCLUDED.subject_label,updated_at=NOW() RETURNING category_label,level_label,learner_label,subject_label`, [req.institution!.id, d.categoryLabel, d.levelLabel, d.learnerLabel, d.subjectLabel]);
  return res.json({ success: true, labels: { category: result.rows[0].category_label, level: result.rows[0].level_label, learner: result.rows[0].learner_label, subject: result.rows[0].subject_label } });
});

router.post("/structure/categories", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = CategorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter a valid category name and description." });
  const d = parsed.data;
  try {
    const result = await pool.query("INSERT INTO institution_categories(institution_id,name,description,sort_order) VALUES($1,$2,$3,$4) RETURNING id,name,description,sort_order,is_active", [req.institution!.id, d.name, d.description, d.sortOrder]);
    return res.status(201).json({ success: true, category: categoryShape(result.rows[0]) });
  } catch (error: any) { return res.status(error?.code === "23505" ? 409 : 500).json({ success: false, message: error?.code === "23505" ? "A category with this name already exists." : "Category could not be created." }); }
});

router.post("/structure/levels", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = LevelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter valid level details." });
  const d = parsed.data;
  try {
    const category = await pool.query("SELECT id FROM institution_categories WHERE id=$1 AND institution_id=$2 AND is_active=true", [d.categoryId, req.institution!.id]);
    if (!category.rows[0]) return res.status(400).json({ success: false, message: "Select a valid institution category." });
    const result = await pool.query("INSERT INTO institution_levels(institution_id,category_id,name,code,learner_count,subjects,sort_order) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *", [req.institution!.id, d.categoryId, d.name, d.code, d.learnerCount, JSON.stringify(d.subjects), d.sortOrder]);
    return res.status(201).json({ success: true, level: levelShape({ ...result.rows[0], category_name: (await pool.query("SELECT name FROM institution_categories WHERE id=$1", [d.categoryId])).rows[0].name, question_count: 0 }) });
  } catch (error: any) { return res.status(error?.code === "23505" ? 409 : 500).json({ success: false, message: error?.code === "23505" ? "A level with this name already exists." : "Level could not be created." }); }
});

router.get("/my-learning", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const accountId = req.user!.accountId || req.user!.id;
  const memberships = await pool.query(`SELECT m.id,m.status,m.source,m.requested_at,m.approved_at,i.id institution_id,i.name institution_name,i.institution_type,i.city,i.state,i.country FROM institution_memberships m JOIN institutions i ON i.id=m.institution_id WHERE m.user_id=$1 ORDER BY m.requested_at DESC`, [accountId]);
  const games = await pool.query(`SELECT c.id,c.name,c.description,c.image_url,a.id age_group_id,a.name age_group_name,COUNT(l.id)::int level_count FROM game_categories c JOIN age_groups a ON a.id=c.age_group_id LEFT JOIN game_levels l ON l.category_id=c.id GROUP BY c.id,a.id ORDER BY a.min_age,c.created_at`);
  return res.json({ success: true, memberships: memberships.rows, availableGames: games.rows });
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
      ? await pool.query("UPDATE institution_memberships SET status='pending',source=$1,requested_at=NOW(),approved_at=NULL WHERE id=$2 RETURNING id,status,requested_at", [source, existing.rows[0].id])
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
  try {
    const result = await pool.query(
      `UPDATE institution_memberships SET status=$1,approved_at=CASE WHEN $1='active' THEN NOW() ELSE NULL END
       WHERE id=$2 AND institution_id=$3 RETURNING id,status,approved_at`, [parsed.data.status, req.params.id, req.institution!.id],
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Join request not found." });
    return res.json({ success: true, message: parsed.data.status === "active" ? "Member approved." : "Join request rejected.", membership: result.rows[0] });
  } catch (error: any) {
    console.error("Institution membership status update failed", { requestId: req.params.id, institutionId: req.institution?.id, status: parsed.data.status, error });
    return res.status(500).json({ success: false, message: "The join request could not be updated. Please try again." });
  }
});

export default router;
