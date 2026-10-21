import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import pool from "../config/database_connection";
import { verifyPlayerToken, type AuthenticatedRequest } from "../middlewares/authentication_middleware";
import { verifyInstitutionToken, type InstitutionRequest } from "../middlewares/institution_authentication_middleware";
import { logActivity } from "../helpers/activityLog";
import { SendInstitutionInvitation } from "../helpers/Mailer";
import { env } from "../config/env";
import { destroyMediaQuietly, StoredMedia, uploadMedia } from "../services/cloudinary_media_service";
import { cleanRichText, plainText } from "../helpers/htmlSanitizer";

const router = Router();
const JoinSchema = z.object({ inviteCode: z.string().trim().max(20).optional().or(z.literal("")) });
const InvitationSchema = z.object({ target: z.string().trim().min(7).max(320) });
const StatusSchema = z.object({ status: z.enum(["active", "rejected"]) });
const StructureSettingsSchema = z.object({ categoryLabel: z.string().trim().min(2).max(80), levelLabel: z.string().trim().min(2).max(80), learnerLabel: z.string().trim().min(2).max(80), subjectLabel: z.string().trim().min(2).max(80) });
const CategorySchema = z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).default(""), sortOrder: z.coerce.number().int().min(0).max(10000).default(0) });
const LevelSchema = z.object({ categoryId: z.string().uuid(), name: z.string().trim().min(2).max(120), code: z.string().trim().max(80).default(""), learnerCount: z.coerce.number().int().min(0).max(1000000).default(0), subjects: z.array(z.string().trim().min(1).max(120)).max(50).default([]), sortOrder: z.coerce.number().int().min(0).max(10000).default(0) });
const institutionQuestionUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 5 }, fileFilter: (_req, file, done) => { const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/aac", "video/mp4", "video/webm", "video/quicktime", "application/pdf", "text/plain", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]; if (allowed.includes(file.mimetype)) done(null, true); else done(new Error("Unsupported question media type.")); } });
const institutionQuestionFields = [{ name: "questionMedia", maxCount: 1 }, ...Array.from({ length: 4 }, (_, index) => ({ name: `optionMedia${index}`, maxCount: 1 }))];
const validInstitutionQuestionImage = (file: Express.Multer.File) => {
  if (!file.mimetype.startsWith("image/")) return true;
  const bytes = file.buffer;
  if (file.mimetype === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === "image/png") return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (file.mimetype === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (file.mimetype === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
};
const institutionShapeSchema = z.object({ type: z.enum(["circle", "square", "rectangle", "triangle", "star", "hexagon"]), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).nullable();
const jsonShape = z.string().transform((value, ctx) => { try { return institutionShapeSchema.parse(JSON.parse(value)); } catch { ctx.addIssue({ code: "custom", message: "Invalid shape selection." }); return z.NEVER; } });
const institutionOptionSchema = z.object({ text: z.string().trim().max(5000), isCorrect: z.boolean(), mediaType: z.enum(["image", "audio", "video", "document"]).nullable(), shape: jsonShape });
const InstitutionQuestionSchema = z.object({ subject: z.string().trim().min(1).max(120), questionText: z.string().max(10000).default(""), explanation: z.string().max(5000).default(""), questionShape: jsonShape, questionMediaType: z.enum(["", "image", "audio", "video", "document"]).default(""), readAloud: z.enum(["true", "false"]).default("false").transform(value => value === "true"), options: z.string().transform((value, ctx) => { try { return z.array(institutionOptionSchema).length(4).parse(JSON.parse(value)); } catch { ctx.addIssue({ code: "custom", message: "Four valid answer options are required." }); return z.NEVER; } }), status: z.enum(["draft", "published"]).default("draft") }).refine(data => data.options.filter(option => option.isCorrect).length === 1, { message: "Exactly one answer option must be marked correct." });
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
    pool.query(`SELECT l.*,c.name category_name,(SELECT COUNT(*)::int FROM institution_questions q WHERE q.level_id=l.id) question_count FROM institution_levels l JOIN institution_categories c ON c.id=l.category_id WHERE l.institution_id=$1 AND l.is_active=true AND c.is_active=true ORDER BY l.sort_order,l.created_at`, [institutionId]),
  ]);
  return res.json({ success: true, labels: settings.rows[0] ? { category: settings.rows[0].category_label, level: settings.rows[0].level_label, learner: settings.rows[0].learner_label, subject: settings.rows[0].subject_label } : { category: "Section", level: "Class", learner: "Learners", subject: "Learning areas" }, categories: categories.rows.map(categoryShape), levels: levels.rows.map(levelShape) });
});

router.put("/structure/settings", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = StructureSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter valid names for each structure label." });
  const d = parsed.data;
  const result = await pool.query(`INSERT INTO institution_structure_settings(institution_id,category_label,level_label,learner_label,subject_label) VALUES($1,$2,$3,$4,$5) ON CONFLICT(institution_id) DO UPDATE SET category_label=EXCLUDED.category_label,level_label=EXCLUDED.level_label,learner_label=EXCLUDED.learner_label,subject_label=EXCLUDED.subject_label,updated_at=NOW() RETURNING category_label,level_label,learner_label,subject_label`, [req.institution!.id, d.categoryLabel, d.levelLabel, d.learnerLabel, d.subjectLabel]);
  await logActivity({ eventType: "institution.structure_settings_updated", title: "Learning structure naming updated", description: "Institution structure labels were updated", metadata: { institutionId: req.institution!.id } });
  return res.json({ success: true, labels: { category: result.rows[0].category_label, level: result.rows[0].level_label, learner: result.rows[0].learner_label, subject: result.rows[0].subject_label } });
});

router.post("/structure/categories", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = CategorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter a valid category name and description." });
  const d = parsed.data;
  try {
    const result = await pool.query("INSERT INTO institution_categories(institution_id,name,description,sort_order) VALUES($1,$2,$3,$4) RETURNING id,name,description,sort_order,is_active", [req.institution!.id, d.name, d.description, d.sortOrder]);
    await logActivity({ eventType: "institution.category_created", title: "Learning section created", description: `${d.name} was added to the institution structure`, metadata: { institutionId: req.institution!.id, categoryId: result.rows[0].id } });
    return res.status(201).json({ success: true, category: categoryShape(result.rows[0]) });
  } catch (error: any) { return res.status(error?.code === "23505" ? 409 : 500).json({ success: false, message: error?.code === "23505" ? "A category with this name already exists." : "Category could not be created." }); }
});

router.patch("/structure/categories/:id", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = CategorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter a valid category name and description." });
  try {
    const result = await pool.query("UPDATE institution_categories SET name=$1,description=$2,sort_order=$3,updated_at=NOW() WHERE id=$4 AND institution_id=$5 AND is_active=true RETURNING id,name,description,sort_order,is_active", [parsed.data.name, parsed.data.description, parsed.data.sortOrder, req.params.id, req.institution!.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Section not found." });
    await logActivity({ eventType: "institution.category_updated", title: "Learning section updated", description: `${parsed.data.name} was updated`, metadata: { institutionId: req.institution!.id, categoryId: req.params.id } });
    return res.json({ success: true, category: categoryShape(result.rows[0]) });
  } catch (error: any) { return res.status(error?.code === "23505" ? 409 : 500).json({ success: false, message: error?.code === "23505" ? "A section with this name already exists." : "Section could not be updated." }); }
});

router.delete("/structure/categories/:id", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  try {
    const levels = await pool.query("SELECT COUNT(*)::int count FROM institution_levels WHERE category_id=$1 AND institution_id=$2 AND is_active=true", [req.params.id, req.institution!.id]);
    if (Number(levels.rows[0]?.count || 0) > 0) return res.status(409).json({ success: false, message: "Move or delete the classes in this section before deleting it." });
    const result = await pool.query("DELETE FROM institution_categories WHERE id=$1 AND institution_id=$2 RETURNING id", [req.params.id, req.institution!.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Section not found." });
    await logActivity({ eventType: "institution.category_deleted", title: "Learning section deleted", description: "An institution learning section was deleted", metadata: { institutionId: req.institution!.id, categoryId: req.params.id } });
    return res.json({ success: true, message: "Section deleted." });
  } catch { return res.status(500).json({ success: false, message: "Section could not be deleted." }); }
});

router.post("/structure/levels", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = LevelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter valid level details." });
  const d = parsed.data;
  try {
    const category = await pool.query("SELECT id FROM institution_categories WHERE id=$1 AND institution_id=$2 AND is_active=true", [d.categoryId, req.institution!.id]);
    if (!category.rows[0]) return res.status(400).json({ success: false, message: "Select a valid institution category." });
    const result = await pool.query("INSERT INTO institution_levels(institution_id,category_id,name,code,learner_count,subjects,sort_order) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *", [req.institution!.id, d.categoryId, d.name, d.code, d.learnerCount, JSON.stringify(d.subjects), d.sortOrder]);
    await logActivity({ eventType: "institution.level_created", title: "Class created", description: `${d.name} was added to the institution structure`, metadata: { institutionId: req.institution!.id, levelId: result.rows[0].id, categoryId: d.categoryId } });
    return res.status(201).json({ success: true, level: levelShape({ ...result.rows[0], category_name: (await pool.query("SELECT name FROM institution_categories WHERE id=$1", [d.categoryId])).rows[0].name, question_count: 0 }) });
  } catch (error: any) { return res.status(error?.code === "23505" ? 409 : 500).json({ success: false, message: error?.code === "23505" ? "A level with this name already exists." : "Level could not be created." }); }
});

router.patch("/structure/levels/:id", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = LevelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter valid level details." });
  const d = parsed.data;
  try {
    const category = await pool.query("SELECT id,name FROM institution_categories WHERE id=$1 AND institution_id=$2 AND is_active=true", [d.categoryId, req.institution!.id]);
    if (!category.rows[0]) return res.status(400).json({ success: false, message: "Select a valid institution section." });
    const result = await pool.query("UPDATE institution_levels SET category_id=$1,name=$2,code=$3,learner_count=$4,subjects=$5::jsonb,sort_order=$6,updated_at=NOW() WHERE id=$7 AND institution_id=$8 AND is_active=true RETURNING *", [d.categoryId, d.name, d.code, d.learnerCount, JSON.stringify(d.subjects), d.sortOrder, req.params.id, req.institution!.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Class not found." });
    const questionCount = await pool.query("SELECT COUNT(*)::int count FROM institution_questions WHERE level_id=$1", [req.params.id]);
    await logActivity({ eventType: "institution.level_updated", title: "Class updated", description: `${d.name} was updated`, metadata: { institutionId: req.institution!.id, levelId: req.params.id, categoryId: d.categoryId } });
    return res.json({ success: true, level: levelShape({ ...result.rows[0], category_name: category.rows[0].name, question_count: questionCount.rows[0]?.count || 0 }) });
  } catch (error: any) { return res.status(error?.code === "23505" ? 409 : 500).json({ success: false, message: error?.code === "23505" ? "A class with this name already exists." : "Class could not be updated." }); }
});

router.delete("/structure/levels/:id", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  try {
    const result = await pool.query("DELETE FROM institution_levels WHERE id=$1 AND institution_id=$2 RETURNING id", [req.params.id, req.institution!.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Class not found." });
    await logActivity({ eventType: "institution.level_deleted", title: "Class deleted", description: "An institution class was deleted", metadata: { institutionId: req.institution!.id, levelId: req.params.id } });
    return res.json({ success: true, message: "Class deleted." });
  } catch { return res.status(500).json({ success: false, message: "Class could not be deleted." }); }
});

router.post("/structure/levels/:id/questions", verifyInstitutionToken, institutionQuestionUpload.fields(institutionQuestionFields), async (req: InstitutionRequest, res) => {
  const parsed = InstitutionQuestionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Enter a valid question and four answer options." });
  const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
  if (Object.values(files).flat().some(file => !validInstitutionQuestionImage(file))) return res.status(400).json({ success: false, message: "One of the selected images is invalid." });
  const questionFile = files.questionMedia?.[0];
  const optionFiles = parsed.data.options.map((_, index) => files[`optionMedia${index}`]?.[0]);
  const questionText = cleanRichText(parsed.data.questionText);
  const optionTexts = parsed.data.options.map(option => cleanRichText(option.text));
  if (!plainText(questionText) && !questionFile && !parsed.data.questionShape) return res.status(400).json({ success: false, message: "Add question text, media, or a shape." });
  if (parsed.data.options.some((option, index) => !plainText(optionTexts[index] || "") && !optionFiles[index] && !option.shape)) return res.status(400).json({ success: false, message: "Every answer option needs text, media, or a shape." });
  const level = await pool.query("SELECT id FROM institution_levels WHERE id=$1 AND institution_id=$2 AND is_active=true", [req.params.id, req.institution!.id]);
  if (!level.rows[0]) return res.status(404).json({ success: false, message: "Class not found." });
  const client = await pool.connect();
  const stored: StoredMedia[] = [];
  let committed = false;
  try {
    const mediaFiles = [questionFile, ...optionFiles];
    const uploaded: (StoredMedia | null)[] = [];
    for (const file of mediaFiles) { const item = file ? await uploadMedia(file, "institution-questions") : null; uploaded.push(item); if (item) stored.push(item); }
    await client.query("BEGIN");
    const shape = parsed.data.questionShape;
    const question = await client.query(
      "INSERT INTO institution_questions(institution_id,level_id,subject,question_text,explanation,status,media_url,media_type,read_aloud,shape_type,shape_color) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,subject,question_text,explanation,status,created_at,media_url,media_type,read_aloud,shape_type,shape_color",
      [req.institution!.id, req.params.id, parsed.data.subject, questionText, parsed.data.explanation, parsed.data.status, uploaded[0]?.url || null, questionFile ? parsed.data.questionMediaType : null, parsed.data.readAloud, shape?.type || null, shape?.color || null],
    );
    for (let index = 0; index < parsed.data.options.length; index += 1) {
      const option = parsed.data.options[index]!;
      const optionShape = option.shape;
      await client.query(
        "INSERT INTO institution_question_options(question_id,option_order,option_text,is_correct,media_url,media_type,shape_type,shape_color) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [question.rows[0].id, index, optionTexts[index], option.isCorrect, uploaded[index + 1]?.url || null, optionFiles[index] ? option.mediaType : null, optionShape?.type || null, optionShape?.color || null],
      );
    }
    await client.query("COMMIT");
    committed = true;
    try { await logActivity({ eventType: "institution.question_created", title: "Institution question created", description: `A question was added to ${parsed.data.subject}`, metadata: { institutionId: req.institution!.id, levelId: req.params.id, subject: parsed.data.subject } }); }
    catch (activityError) { console.error("Institution question activity log failed", activityError); }
    return res.status(201).json({ success: true, question: { ...question.rows[0], options: parsed.data.options.map((option, index) => ({ text: optionTexts[index], isCorrect: option.isCorrect, mediaUrl: uploaded[index + 1]?.url || null, mediaType: optionFiles[index] ? option.mediaType : null, shapeType: option.shape?.type || null, shapeColor: option.shape?.color || null })) } });
  } catch (error) {
    if (!committed) { await client.query("ROLLBACK"); await Promise.all(stored.map(destroyMediaQuietly)); }
    console.error("Institution question creation failed", error);
    return res.status(500).json({ success: false, message: "Question could not be saved. Please try again." });
  } finally { client.release(); }
});
router.get("/questions", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const result = await pool.query(`SELECT q.id,q.subject,q.question_text,q.explanation,q.status,q.created_at,q.updated_at,q.media_url,q.media_type,q.read_aloud,q.shape_type,q.shape_color,COALESCE(json_agg(json_build_object('text',o.option_text,'isCorrect',o.is_correct,'mediaUrl',o.media_url,'mediaType',o.media_type,'shapeType',o.shape_type,'shapeColor',o.shape_color) ORDER BY o.option_order) FILTER (WHERE o.id IS NOT NULL),'[]') options,l.name level_name,c.name category_name FROM institution_questions q JOIN institution_levels l ON l.id=q.level_id JOIN institution_categories c ON c.id=l.category_id LEFT JOIN institution_question_options o ON o.question_id=q.id WHERE q.institution_id=$1 GROUP BY q.id,l.name,c.name ORDER BY q.created_at DESC`, [req.institution!.id]);
  return res.json({ success: true, questions: result.rows.map((row: Record<string, any>) => ({ id: row.id, text: row.question_text, explanation: row.explanation, subject: row.subject, level: row.level_name, section: row.category_name, type: "Multiple choice", status: row.status === "published" ? "Published" : "Draft", updated: row.updated_at, plays: 0, mediaUrl: row.media_url, mediaType: row.media_type, readAloud: row.read_aloud, shapeType: row.shape_type, shapeColor: row.shape_color, options: row.options })) });
});

router.delete("/questions/:id", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const stored = await pool.query(`SELECT q.id,q.subject,q.level_id,q.media_url,COALESCE(array_agg(o.media_url) FILTER (WHERE o.media_url IS NOT NULL),ARRAY[]::text[]) option_media FROM institution_questions q LEFT JOIN institution_question_options o ON o.question_id=q.id WHERE q.id=$1 AND q.institution_id=$2 GROUP BY q.id`, [req.params.id, req.institution!.id]);
  if (!stored.rows[0]) return res.status(404).json({ success: false, message: "Question not found." });
  const result = await pool.query("DELETE FROM institution_questions WHERE id=$1 AND institution_id=$2 RETURNING id", [req.params.id, req.institution!.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Question not found." });
  await Promise.all([stored.rows[0].media_url, ...(stored.rows[0].option_media || [])].filter(Boolean).map(destroyMediaQuietly));
  await logActivity({ eventType: "institution.question_deleted", title: "Institution question deleted", description: `A question was removed from ${stored.rows[0].subject}`, metadata: { institutionId: req.institution!.id, levelId: stored.rows[0].level_id } });
  return res.json({ success: true, message: "Question deleted." });
});

router.get("/activity", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const result = await pool.query(
    `SELECT id,event_type,title,description,actor_name,metadata,created_at
     FROM activity_logs WHERE metadata->>'institutionId'=$1 ORDER BY created_at DESC LIMIT 100`, [req.institution!.id],
  );
  return res.json({ success: true, activities: result.rows });
});

router.get("/dashboard", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const institutionId = req.institution!.id;
  const [metrics, activities, requests] = await Promise.all([
    pool.query(`SELECT (SELECT COUNT(*)::int FROM institution_memberships WHERE institution_id=$1 AND status='active') students,(SELECT COUNT(*)::int FROM institution_questions WHERE institution_id=$1) questions,(SELECT COUNT(*)::int FROM institution_memberships WHERE institution_id=$1 AND status='pending') pending_requests`, [institutionId]),
    pool.query(`SELECT id,event_type,title,description,actor_name,metadata,created_at FROM activity_logs WHERE metadata->>'institutionId'=$1 ORDER BY created_at DESC LIMIT 4`, [institutionId]),
    pool.query(`SELECT m.id,u.name,u.username,u.email,m.requested_at FROM institution_memberships m JOIN users u ON u.id=m.user_id WHERE m.institution_id=$1 AND m.status='pending' ORDER BY m.requested_at DESC LIMIT 5`, [institutionId]),
  ]);
  return res.json({ success: true, metrics: metrics.rows[0] || { students: 0, questions: 0, pending_requests: 0 }, activities: activities.rows, requests: requests.rows });
});

router.get("/students", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const result = await pool.query(`SELECT m.id,u.name,u.username,u.email,m.status,m.approved_at FROM institution_memberships m JOIN users u ON u.id=m.user_id WHERE m.institution_id=$1 AND m.status='active' ORDER BY u.name`, [req.institution!.id]);
  return res.json({ success: true, students: result.rows.map((row: Record<string, any>) => ({ id: row.id, name: row.name, username: row.username, email: row.email, className: "Not assigned", progress: 0, lastSeen: row.approved_at ? new Date(row.approved_at).toLocaleDateString() : "Not available", status: "Active", initials: String(row.name || "IN").split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase() })) });
});

router.get("/students/:studentId", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.studentId);
  if (!parsedId.success) return res.status(404).json({ success: false, message: "Student not found in this institution." });
  const membership = await pool.query(
    `SELECT m.id,m.status,COALESCE(m.approved_at,m.requested_at) joined_at,u.id user_id,u.name,u.username,u.email,u.phone,u.age,u.total_xp,u.created_at,
       (SELECT MAX(a.created_at) FROM gameplay_attempts a WHERE a.user_id=u.id) last_active
     FROM institution_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.id=$1 AND m.institution_id=$2 AND m.status='active'`,
    [parsedId.data, req.institution!.id],
  );
  if (!membership.rows[0]) return res.status(404).json({ success: false, message: "Student not found in this institution." });
  const userId = membership.rows[0].user_id;
  const [summary, activity] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int attempts,COUNT(*) FILTER (WHERE passed)::int passed,ROUND(AVG(score_percent))::int average_score FROM gameplay_attempts WHERE user_id=$1`, [userId]),
    pool.query(`SELECT a.id,a.score_percent,a.passed,a.created_at,COALESCE(g.name,l.title,'Learning activity') level_name FROM gameplay_attempts a LEFT JOIN game_levels g ON g.id=a.level_id LEFT JOIN learning_items l ON l.id=a.learning_level_id WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 10`, [userId]),
  ]);
  const row = membership.rows[0];
  return res.json({
    success: true,
    student: { id: row.id, name: row.name, username: row.username, email: row.email, phone: row.phone, age: row.age, totalXp: Number(row.total_xp || 0), status: row.status === "active" ? "Active" : row.status, joinedAt: row.joined_at, lastPracticeAt: row.last_active, initials: String(row.name || "IN").split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase() },
    summary: { attempts: Number(summary.rows[0]?.attempts || 0), passed: Number(summary.rows[0]?.passed || 0), averageScore: summary.rows[0]?.average_score == null ? null : Number(summary.rows[0].average_score) },
    recentActivity: activity.rows.map((item: Record<string, any>) => ({ id: item.id, activity: item.passed ? "Passed practice" : "Completed practice", levelName: item.level_name, score: Number(item.score_percent), passed: item.passed, createdAt: item.created_at })),
  });
});
router.get("/my-learning/:institutionId", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.institutionId);
  if (!parsedId.success) return res.status(404).json({ success: false, message: "Institution not found." });
  const accountId = req.user!.accountId || req.user!.id;
  const membership = await pool.query(
    `SELECT i.id,i.name,i.institution_type,i.city,i.state
     FROM institution_memberships m JOIN institutions i ON i.id=m.institution_id
     WHERE m.user_id=$1 AND m.institution_id=$2 AND m.status='active' AND i.is_active=true`,
    [accountId, parsedId.data],
  );
  if (!membership.rows[0]) return res.status(404).json({ success: false, message: "Active institution membership not found." });
  const [levels, questions] = await Promise.all([
    pool.query(`SELECT l.id,l.name,l.code,l.subjects,c.name category_name FROM institution_levels l JOIN institution_categories c ON c.id=l.category_id WHERE l.institution_id=$1 AND l.is_active=true AND c.is_active=true ORDER BY c.sort_order,l.sort_order,l.name`, [parsedId.data]),
    pool.query(`SELECT q.id,q.level_id,q.subject,q.question_text,q.media_url,q.media_type,q.read_aloud,q.shape_type,q.shape_color,q.created_at,COALESCE(json_agg(json_build_object('text',o.option_text,'mediaUrl',o.media_url,'mediaType',o.media_type,'shapeType',o.shape_type,'shapeColor',o.shape_color) ORDER BY o.option_order) FILTER (WHERE o.id IS NOT NULL),'[]') options FROM institution_questions q JOIN institution_levels l ON l.id=q.level_id AND l.is_active=true JOIN institution_categories c ON c.id=l.category_id AND c.is_active=true LEFT JOIN institution_question_options o ON o.question_id=q.id WHERE q.institution_id=$1 AND q.status='published' GROUP BY q.id ORDER BY q.created_at DESC`, [parsedId.data]),
  ]);
  return res.json({
    success: true,
    institution: { id: membership.rows[0].id, name: membership.rows[0].name, institutionType: membership.rows[0].institution_type, city: membership.rows[0].city, state: membership.rows[0].state },
    levels: levels.rows.map((row: Record<string, any>) => ({ id: row.id, name: row.name, code: row.code, category: row.category_name, subjects: Array.isArray(row.subjects) ? row.subjects : [] })),
    questions: questions.rows.map((row: Record<string, any>) => ({ id: row.id, levelId: row.level_id, subject: row.subject, text: row.question_text, mediaUrl: row.media_url, mediaType: row.media_type, readAloud: row.read_aloud, shapeType: row.shape_type, shapeColor: row.shape_color, options: row.options })),
  });
});

router.post("/my-learning/:institutionId/questions/:questionId/answer", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const institutionId = z.string().uuid().safeParse(req.params.institutionId);
  const questionId = z.string().uuid().safeParse(req.params.questionId);
  const answer = z.object({ optionIndex: z.coerce.number().int().min(0).max(3) }).safeParse(req.body || {});
  if (!institutionId.success || !questionId.success || !answer.success) return res.status(400).json({ success: false, message: "Choose one of the available answers." });
  const accountId = req.user!.accountId || req.user!.id;
  const result = await pool.query(
    `SELECT o.is_correct,q.explanation
     FROM institution_questions q JOIN institution_question_options o ON o.question_id=q.id AND o.option_order=$3
     WHERE q.id=$1 AND q.institution_id=$2 AND q.status='published'
       AND EXISTS (SELECT 1 FROM institution_memberships m WHERE m.institution_id=$2 AND m.user_id=$4 AND m.status='active')`,
    [questionId.data, institutionId.data, answer.data.optionIndex, accountId],
  );
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Published question not found." });
  const correct = Boolean(result.rows[0].is_correct);
  return res.json({ success: true, correct, explanation: correct ? result.rows[0].explanation : null });
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

router.delete("/my-memberships/:id", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const accountId = req.user!.accountId || req.user!.id;
  try {
    const result = await pool.query(
      `DELETE FROM institution_memberships
       WHERE id=$1 AND user_id=$2 AND status='pending'
       RETURNING id,institution_id`,
      [req.params.id, accountId],
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Only pending join requests can be canceled." });
    await logActivity({
      eventType: "institution.join_request_canceled",
      title: "Institution join request canceled",
      description: "A player canceled their pending institution join request",
      actorId: accountId,
      metadata: { institutionId: result.rows[0].institution_id, membershipId: result.rows[0].id },
    });
    return res.json({ success: true, message: "Your institution request was canceled." });
  } catch (error) {
    console.error("Institution join request cancellation failed", { requestId: req.params.id, accountId, error });
    return res.status(500).json({ success: false, message: "Your join request could not be canceled. Please try again." });
  }
});

router.get("/requests", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const result = await pool.query(
    `SELECT m.id,m.status,m.source,m.requested_at,m.approved_at,u.id user_id,u.name,u.username,u.email
     FROM institution_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.institution_id=$1 ORDER BY CASE WHEN m.status='pending' THEN 0 ELSE 1 END,m.requested_at DESC`, [req.institution!.id],
  );
  return res.json({ success: true, requests: result.rows });
});

router.post("/invitations", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = InvitationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter a valid email address or phone number." });
  const target = parsed.data.target.trim();
  const isEmail = /^\S+@\S+\.\S+$/.test(target);
  const isPhone = /^\+?[1-9]\d{6,14}$/.test(target.replace(/[\s()-]/g, ""));
  if (!isEmail && !isPhone) return res.status(400).json({ success: false, message: "Enter a valid email address or international phone number." });
  const channel = isEmail ? "email" : "phone";
  const institution = await pool.query("SELECT id,name,invite_code FROM institutions WHERE id=$1 AND is_active=true", [req.institution!.id]);
  if (!institution.rows[0]) return res.status(404).json({ success: false, message: "Institution not found." });
  const inviteLink = `${env.USER_APP_URL}/institutions?code=${encodeURIComponent(institution.rows[0].invite_code)}`;
  try {
    if (isEmail) await SendInstitutionInvitation(target.toLowerCase(), institution.rows[0].name, inviteLink);
    const saved = await pool.query("INSERT INTO institution_invitations(institution_id,target,channel) VALUES($1,$2,$3) RETURNING id,channel,created_at", [req.institution!.id, isEmail ? target.toLowerCase() : target.replace(/[\s()-]/g, ""), channel]);
    await logActivity({ eventType: "institution.invitation_sent", title: "Institution invitation sent", description: `An institution invitation was prepared for a ${channel} contact`, metadata: { institutionId: req.institution!.id, invitationId: saved.rows[0].id, channel } });
    return res.status(201).json({ success: true, channel, inviteLink, message: isEmail ? "Invitation email sent." : "SMS invitation ready to send." });
  } catch (error: any) {
    console.error("Institution invitation failed", { institutionId: req.institution!.id, channel, error });
    return res.status(502).json({ success: false, message: isEmail ? "Invitation email could not be sent. Check email delivery settings." : "The phone invitation could not be prepared." });
  }
});

router.patch("/requests/:id", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = StatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Choose whether to approve or reject this request." });
  try {
    const result = await pool.query(
      `UPDATE institution_memberships SET status=$1::varchar,approved_at=CASE WHEN $1::text='active' THEN NOW() ELSE NULL END
       WHERE id=$2 AND institution_id=$3 AND status='pending' RETURNING id,status,approved_at`, [parsed.data.status, req.params.id, req.institution!.id],
    );
    if (!result.rows[0]) return res.status(409).json({ success: false, message: "This join request is no longer pending." });
    await logActivity({ eventType: `institution.join_request_${parsed.data.status === "active" ? "approved" : "rejected"}`, title: parsed.data.status === "active" ? "Learner approved" : "Join request rejected", description: parsed.data.status === "active" ? "A learner was approved to join the institution" : "A learner join request was rejected", metadata: { institutionId: req.institution!.id, membershipId: req.params.id } });
    return res.json({ success: true, message: parsed.data.status === "active" ? "Member approved." : "Join request rejected.", membership: result.rows[0] });
  } catch (error: any) {
    console.error("Institution membership status update failed", { requestId: req.params.id, institutionId: req.institution?.id, status: parsed.data.status, error });
    return res.status(500).json({ success: false, message: "The join request could not be updated. Please try again." });
  }
});

export default router;
