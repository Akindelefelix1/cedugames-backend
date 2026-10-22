import { Router } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { z } from "zod";
import pool from "../config/database_connection";
import { verifyPlayerToken, type AuthenticatedRequest } from "../middlewares/authentication_middleware";
import { verifyInstitutionToken, type InstitutionRequest } from "../middlewares/institution_authentication_middleware";
import { logActivity, purgeExpiredInstitutionActivity, purgeExpiredInstitutionLearningHistory } from "../helpers/activityLog";
import { SendInstitutionInvitation } from "../helpers/Mailer";
import { env } from "../config/env";
import { destroyMediaQuietly, StoredMedia, uploadMedia } from "../services/cloudinary_media_service";
import { cleanRichText, plainText } from "../helpers/htmlSanitizer";
import { generateQuestionDrafts } from "../services/ai_question_service";
import { recordCoinTransaction } from "../services/coin_service";

const router = Router();
const JoinSchema = z.object({ inviteCode: z.string().trim().max(20).optional().or(z.literal("")) });
const InvitationSchema = z.object({ target: z.string().trim().min(7).max(320) });
const StatusSchema = z.object({ status: z.enum(["active", "rejected"]) });
const InstitutionActivityRetentionSchema = z.object({ retentionDays: z.union([z.literal(15), z.literal(30)]) });
const InstitutionPracticeSettingsSchema = z.object({ questionsPerPlay: z.coerce.number().int().min(1).max(200) });
const InstitutionPracticeStartSchema = z.object({ levelId: z.string().uuid(), subject: z.string().trim().min(1).max(120) });
const InstitutionPracticeReviewSchema = z.object({ attemptIds: z.array(z.string().uuid()).min(1).max(200) });
const StructureSettingsSchema = z.object({ categoryLabel: z.string().trim().min(2).max(80), levelLabel: z.string().trim().min(2).max(80), learnerLabel: z.string().trim().min(2).max(80), subjectLabel: z.string().trim().min(2).max(80) });
const CategorySchema = z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).default(""), sortOrder: z.coerce.number().int().min(0).max(10000).default(0) });
const LevelSchema = z.object({ categoryId: z.string().uuid(), name: z.string().trim().min(2).max(120), code: z.string().trim().max(80).default(""), learnerCount: z.coerce.number().int().min(0).max(1000000).default(0), subjects: z.array(z.string().trim().min(1).max(120)).max(50).default([]), sortOrder: z.coerce.number().int().min(0).max(10000).default(0) });
const DeleteConfirmationSchema = z.object({ confirmationName: z.string().trim().min(1).max(120) });
const confirmInstitutionDelete = (req: InstitutionRequest, res: any, name: string) => {
  const parsed = DeleteConfirmationSchema.safeParse(req.body || {});
  if (!parsed.success || parsed.data.confirmationName !== name) {
    res.status(400).json({ success: false, code: "DELETE_NAME_CONFIRMATION_REQUIRED", message: `Type ${name} exactly to confirm deletion.` });
    return false;
  }
  return true;
};
const institutionQuestionUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 5 }, fileFilter: (_req, file, done) => { const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/aac", "video/mp4", "video/webm", "video/quicktime", "application/pdf", "text/plain", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]; if (allowed.includes(file.mimetype)) done(null, true); else done(new Error("Unsupported question media type.")); } });
const institutionCsvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, done) => ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain", "application/octet-stream"].includes(file.mimetype) ? done(null, true) : done(new Error("Choose a CSV file.")) });
const parseInstitutionCsvRows = (source: string) => {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < source.length; index += 1) { const character = source[index]!; if (character === '"') { if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; } else quoted = !quoted; } else if (character === "," && !quoted) { row.push(cell.trim()); cell = ""; } else if ((character === "\n" || character === "\r") && !quoted) { if (character === "\r" && source[index + 1] === "\n") index += 1; row.push(cell.trim()); cell = ""; if (row.some(Boolean)) rows.push(row); row = []; } else cell += character; }
  if (cell || row.length) { row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); }
  return rows.map(values => values.map(value => value.replace(/^\uFEFF/, "")));
};
const parseInstitutionBulkQuestions = (source: string) => {
  const rows = parseInstitutionCsvRows(source);
  const headers = rows[0]?.map(value => value.trim().toLowerCase()) || [];
  const required = ["questions", "option a", "option b", "option c", "option d", "correct answer"];
  const timed = headers.length === 7 && headers[6] === "time limit (seconds)";
  if (!rows.length) return { errors: ["The CSV file is empty."], questions: [] };
  if ((!timed && headers.length !== 6) || required.some((header, index) => headers[index] !== header)) return { errors: ["Use the Admin template headings: Questions, Option A, Option B, Option C, Option D, Correct Answer. You may add Time Limit (seconds) as a seventh column."], questions: [] };
  const errors: string[] = [];
  if (rows.length > 501) return { errors: ["Upload no more than 500 questions in one file."], questions: [] };
  const questions = rows.slice(1).map((values, index) => {
    const line = index + 2;
    if (values.length !== headers.length) { errors.push(`Row ${line} must contain ${headers.length} columns.`); return null; }
    const correct = ["option a", "option b", "option c", "option d"].indexOf((values[5] || "").toLowerCase().replace(/\s+/g, " "));
    if (correct < 0) { errors.push(`Row ${line} must use Option A, Option B, Option C, or Option D as the correct answer.`); return null; }
    const text = values[0] || ""; const options = values.slice(1, 5);
    if (!text || text.length > 500 || options.some(option => !option || option.length > 180)) { errors.push(`Row ${line} must include a question (up to 500 characters) and four options (up to 180 characters each).`); return null; }
    const timeLimitSeconds = timed && values[6] ? Number(values[6]) : 30;
    if (!Number.isInteger(timeLimitSeconds) || timeLimitSeconds < 5 || timeLimitSeconds > 600) { errors.push(`Row ${line} time limit must be a whole number from 5 to 600 seconds.`); return null; }
    return { text, options, correct, timeLimitSeconds };
  }).filter(Boolean) as Array<{ text: string; options: string[]; correct: number; timeLimitSeconds: number }>;
  if (!questions.length && !errors.length) errors.push("The CSV contains no question rows.");
  return { errors, questions };
};
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
const InstitutionQuestionSchema = z.object({ subject: z.string().trim().min(1).max(120), timeLimitSeconds: z.coerce.number().int().min(5).max(600).default(30), questionText: z.string().max(10000).default(""), explanation: z.string().max(5000).default(""), questionShape: jsonShape, questionMediaType: z.enum(["", "image", "audio", "video", "document"]).default(""), readAloud: z.enum(["true", "false"]).default("false").transform(value => value === "true"), options: z.string().transform((value, ctx) => { try { return z.array(institutionOptionSchema).length(4).parse(JSON.parse(value)); } catch { ctx.addIssue({ code: "custom", message: "Four valid answer options are required." }); return z.NEVER; } }), status: z.enum(["draft", "published"]).default("draft") }).refine(data => data.options.filter(option => option.isCorrect).length === 1, { message: "Exactly one answer option must be marked correct." });
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
  const [settings, categories, levels, institutionPolicy] = await Promise.all([
    pool.query("SELECT category_label,level_label,learner_label,subject_label FROM institution_structure_settings WHERE institution_id=$1", [institutionId]),
    pool.query("SELECT c.*,COUNT(l.id)::int level_count FROM institution_categories c LEFT JOIN institution_levels l ON l.category_id=c.id AND l.is_active=true WHERE c.institution_id=$1 AND c.is_active=true GROUP BY c.id ORDER BY c.sort_order,c.created_at", [institutionId]),
    pool.query(`SELECT l.*,c.name category_name,(SELECT COUNT(*)::int FROM institution_questions q WHERE q.level_id=l.id) question_count FROM institution_levels l JOIN institution_categories c ON c.id=l.category_id WHERE l.institution_id=$1 AND l.is_active=true AND c.is_active=true ORDER BY l.sort_order,l.created_at`, [institutionId]),
    pool.query("SELECT publishing_policy,questions_per_play FROM institutions WHERE id=$1", [institutionId]),
  ]);
  return res.json({ success: true, publishingPolicy: institutionPolicy.rows[0]?.publishing_policy || "admin_review", questionsPerPlay: Number(institutionPolicy.rows[0]?.questions_per_play || 10), labels: settings.rows[0] ? { category: settings.rows[0].category_label, level: settings.rows[0].level_label, learner: settings.rows[0].learner_label, subject: settings.rows[0].subject_label } : { category: "Section", level: "Class", learner: "Learners", subject: "Learning areas" }, categories: categories.rows.map(categoryShape), levels: levels.rows.map(levelShape) });
});

router.get("/practice-settings", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const result = await pool.query("SELECT questions_per_play FROM institutions WHERE id=$1", [req.institution!.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Institution not found." });
  return res.json({ success: true, questionsPerPlay: Number(result.rows[0]?.questions_per_play || 10) });
});

router.put("/practice-settings", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = InstitutionPracticeSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Questions per play must be a whole number from 1 to 200." });
  const result = await pool.query("UPDATE institutions SET questions_per_play=$1,updated_at=NOW() WHERE id=$2 RETURNING questions_per_play", [parsed.data.questionsPerPlay, req.institution!.id]);
  if (!result.rows[0]) return res.status(404).json({ success: false, message: "Institution not found." });
  await logActivity({ eventType: "institution.practice_settings_updated", title: "Practice settings updated", description: `Practice sessions now show up to ${result.rows[0].questions_per_play} questions`, metadata: { institutionId: req.institution!.id, questionsPerPlay: result.rows[0].questions_per_play } });
  return res.json({ success: true, questionsPerPlay: Number(result.rows[0].questions_per_play), message: "Practice settings saved." });
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
    const current = await pool.query("SELECT name FROM institution_categories WHERE id=$1 AND institution_id=$2 AND is_active=true", [req.params.id, req.institution!.id]);
    if (!current.rows[0]) return res.status(404).json({ success: false, message: "Section not found." });
    if (!confirmInstitutionDelete(req, res, current.rows[0].name)) return;
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
    const current = await pool.query("SELECT name FROM institution_levels WHERE id=$1 AND institution_id=$2 AND is_active=true", [req.params.id, req.institution!.id]);
    if (!current.rows[0]) return res.status(404).json({ success: false, message: "Class not found." });
    if (!confirmInstitutionDelete(req, res, current.rows[0].name)) return;
    const result = await pool.query("DELETE FROM institution_levels WHERE id=$1 AND institution_id=$2 RETURNING id,name", [req.params.id, req.institution!.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Class not found." });
    await logActivity({ eventType: "institution.level_deleted", title: "Class deleted", description: `${result.rows[0].name} was deleted`, metadata: { institutionId: req.institution!.id, levelId: req.params.id } });
    return res.json({ success: true, message: "Class deleted." });
  } catch { return res.status(500).json({ success: false, message: "Class could not be deleted." }); }
});

const InstitutionQuestionGenerationSchema = z.object({ levelId: z.string().uuid(), subject: z.string().trim().min(1).max(120), guidance: z.string().trim().max(2000).default("") });
router.post("/questions/ai/generate", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = InstitutionQuestionGenerationSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, message: "Choose a valid class and learning area." });
  const placement = await pool.query(
    `SELECT l.id,l.name,l.sort_order,l.code,l.subjects,c.name category_name,c.description category_description
     FROM institution_levels l JOIN institution_categories c ON c.id=l.category_id
     WHERE l.id=$1 AND l.institution_id=$2 AND l.is_active=true AND c.is_active=true`,
    [parsed.data.levelId, req.institution!.id],
  );
  const level = placement.rows[0];
  if (!level) return res.status(404).json({ success: false, message: "This learning placement is no longer available." });
  if (Array.isArray(level.subjects) && level.subjects.length && !level.subjects.includes(parsed.data.subject)) return res.status(400).json({ success: false, message: "Choose a learning area assigned to this class." });
  try {
    const generated = await generateQuestionDrafts({ count: 1, guidance: `${parsed.data.subject}. ${parsed.data.guidance}`.trim(), categoryName: level.category_name, categoryDescription: level.category_description || "", levelName: level.name, levelNumber: Number(level.sort_order || 1), levelDescription: level.code ? `Class code: ${level.code}` : "" });
    return res.json({ success: true, question: generated.questions[0] });
  } catch (error: any) {
    return res.status(error.status || 502).json({ success: false, message: error.message || "Question could not be generated." });
  }
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
  const policyResult = await pool.query("SELECT publishing_policy FROM institutions WHERE id=$1", [req.institution!.id]);
  const autoPublish = policyResult.rows[0]?.publishing_policy === "auto_publish";
  const questionStatus = parsed.data.status === "draft" || !autoPublish ? "draft" : "published";
  const reviewStatus = parsed.data.status === "draft" ? "draft" : questionStatus === "published" ? "approved" : "pending";
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
      "INSERT INTO institution_questions(institution_id,level_id,subject,question_text,explanation,status,review_status,media_url,media_type,read_aloud,shape_type,shape_color,time_limit_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,subject,question_text,explanation,status,review_status,created_at,media_url,media_type,read_aloud,shape_type,shape_color,time_limit_seconds",
      [req.institution!.id, req.params.id, parsed.data.subject, questionText, parsed.data.explanation, questionStatus, reviewStatus, uploaded[0]?.url || null, questionFile ? parsed.data.questionMediaType : null, parsed.data.readAloud, shape?.type || null, shape?.color || null, parsed.data.timeLimitSeconds],
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
router.patch("/questions/:id/resubmit", verifyInstitutionToken, institutionQuestionUpload.fields(institutionQuestionFields), async (req: InstitutionRequest, res) => {
  const questionId = z.string().uuid().safeParse(req.params.id);
  const parsed = InstitutionQuestionSchema.safeParse(req.body);
  if (!questionId.success || !parsed.success) return res.status(400).json({ success: false, message: parsed.success ? "Invalid question." : parsed.error.issues[0]?.message || "Enter a valid question and four answer options." });
  const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
  if (Object.values(files).flat().some(file => !validInstitutionQuestionImage(file))) return res.status(400).json({ success: false, message: "One of the selected images is invalid." });
  const questionFile = files.questionMedia?.[0];
  const optionFiles = parsed.data.options.map((_, index) => files[`optionMedia${index}`]?.[0]);
  const questionText = cleanRichText(parsed.data.questionText);
  const optionTexts = parsed.data.options.map(option => cleanRichText(option.text));
  if (!plainText(questionText) && !questionFile && !parsed.data.questionShape) return res.status(400).json({ success: false, message: "Add question text, media, or a shape." });
  if (parsed.data.options.some((option, index) => !plainText(optionTexts[index] || "") && !optionFiles[index] && !option.shape)) return res.status(400).json({ success: false, message: "Every answer option needs text, media, or a shape." });

  const client = await pool.connect();
  const stored: StoredMedia[] = [];
  let committed = false;
  let replacedMedia: string[] = [];
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT q.id,q.institution_id,q.level_id,q.media_url,q.media_type
       FROM institution_questions q
       WHERE q.id=$1 AND q.institution_id=$2 AND q.status='draft' AND q.review_status='changes_requested'
       FOR UPDATE`,
      [questionId.data, req.institution!.id],
    );
    if (!existing.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "This question is not awaiting changes." }); }
    const level = await client.query("SELECT id FROM institution_levels WHERE id=$1 AND institution_id=$2 AND is_active=true", [req.params.levelId || existing.rows[0].level_id, req.institution!.id]);
    if (!level.rows[0]) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Choose a valid class placement." }); }
    const existingOptions = await client.query("SELECT option_order,media_url,media_type FROM institution_question_options WHERE question_id=$1 ORDER BY option_order", [questionId.data]);
    const mediaFiles = [questionFile, ...optionFiles];
    const uploaded: (StoredMedia | null)[] = [];
    for (const file of mediaFiles) { const item = file ? await uploadMedia(file, "institution-questions") : null; uploaded.push(item); if (item) stored.push(item); }
    const oldMedia = [existing.rows[0].media_url, ...existingOptions.rows.map((item: Record<string, any>) => item.media_url)].filter(Boolean) as string[];
    const questionMediaUrl = uploaded[0]?.url || existing.rows[0].media_url || null;
    const questionMediaType = questionFile ? parsed.data.questionMediaType : existing.rows[0].media_type;
    const policyResult = await client.query("SELECT publishing_policy FROM institutions WHERE id=$1", [req.institution!.id]);
    const autoPublish = policyResult.rows[0]?.publishing_policy === "auto_publish";
    const questionStatus = parsed.data.status === "draft" ? "draft" : autoPublish ? "published" : "draft";
    const reviewStatus = parsed.data.status === "draft" ? "draft" : questionStatus === "published" ? "approved" : "pending";
    const questionShape = parsed.data.questionShape;
    const updated = await client.query(
      `UPDATE institution_questions SET level_id=$2,subject=$3,question_text=$4,explanation=$5,status=$6,review_status=$7,review_notes='',reviewed_at=NULL,reviewed_by=NULL,media_url=$8,media_type=$9,read_aloud=$10,shape_type=$11,shape_color=$12,time_limit_seconds=$13,updated_at=NOW()
       WHERE id=$1 RETURNING id,subject,question_text,explanation,status,review_status,created_at,updated_at,media_url,media_type,read_aloud,shape_type,shape_color,time_limit_seconds`,
      [questionId.data, level.rows[0].id, parsed.data.subject, questionText, parsed.data.explanation, questionStatus, reviewStatus, questionMediaUrl, questionMediaType, parsed.data.readAloud, questionShape?.type || null, questionShape?.color || null, parsed.data.timeLimitSeconds],
    );
    await client.query("DELETE FROM institution_question_options WHERE question_id=$1", [questionId.data]);
    const shapedOptions: { text: string; isCorrect: boolean; mediaUrl: string | null; mediaType: string | null; shapeType: string | null; shapeColor: string | null }[] = [];
    for (let index = 0; index < parsed.data.options.length; index += 1) {
      const option = parsed.data.options[index]!;
      const optionShape = option.shape;
      const previous = existingOptions.rows[index];
      const mediaUrl = uploaded[index + 1]?.url || previous?.media_url || null;
      const mediaType = optionFiles[index] ? option.mediaType : previous?.media_type || null;
      await client.query(
        "INSERT INTO institution_question_options(question_id,option_order,option_text,is_correct,media_url,media_type,shape_type,shape_color) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [questionId.data, index, optionTexts[index], option.isCorrect, mediaUrl, mediaType, optionShape?.type || null, optionShape?.color || null],
      );
      shapedOptions.push({ text: optionTexts[index] || "", isCorrect: option.isCorrect, mediaUrl, mediaType, shapeType: optionShape?.type || null, shapeColor: optionShape?.color || null });
    }
    await client.query("COMMIT");
    committed = true;
    replacedMedia = oldMedia.filter((url, index) => url && ![questionMediaUrl, ...shapedOptions.map(option => option.mediaUrl)].includes(url));
    await Promise.all(replacedMedia.map(destroyMediaQuietly));
    await logActivity({ eventType: "institution.question_resubmitted", title: "Institution question resubmitted", description: `A revised question was submitted for ${parsed.data.subject}`, metadata: { institutionId: req.institution!.id, questionId: questionId.data, reviewStatus } });
    return res.json({ success: true, message: questionStatus === "published" ? "Revised question published." : reviewStatus === "pending" ? "Revised question submitted for admin review." : "Question saved as a draft.", question: { ...updated.rows[0], options: shapedOptions } });
  } catch (error) {
    if (!committed) { await client.query("ROLLBACK"); await Promise.all(stored.map(destroyMediaQuietly)); }
    console.error("Institution question resubmission failed", error);
    return res.status(500).json({ success: false, message: "The revised question could not be saved. Please try again." });
  } finally { client.release(); }
});

router.get("/questions", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const result = await pool.query(`SELECT q.id,q.level_id,q.subject,q.question_text,q.explanation,q.status,q.review_status,q.review_notes,q.created_at,q.updated_at,q.media_url,q.media_type,q.read_aloud,q.shape_type,q.shape_color,q.time_limit_seconds,COALESCE(json_agg(json_build_object('text',o.option_text,'isCorrect',o.is_correct,'mediaUrl',o.media_url,'mediaType',o.media_type,'shapeType',o.shape_type,'shapeColor',o.shape_color) ORDER BY o.option_order) FILTER (WHERE o.id IS NOT NULL),'[]') options,l.name level_name,c.name category_name FROM institution_questions q JOIN institution_levels l ON l.id=q.level_id JOIN institution_categories c ON c.id=l.category_id LEFT JOIN institution_question_options o ON o.question_id=q.id WHERE q.institution_id=$1 GROUP BY q.id,l.name,c.name ORDER BY q.created_at DESC`, [req.institution!.id]);
  return res.json({ success: true, questions: result.rows.map((row: Record<string, any>) => ({ id: row.id, levelId: row.level_id, text: row.question_text, explanation: row.explanation, subject: row.subject, level: row.level_name, section: row.category_name, type: "Multiple choice", status: row.status === "published" ? "Published" : ["pending", "changes_requested"].includes(row.review_status) ? "Needs review" : "Draft", reviewNotes: row.review_notes || "", updated: row.updated_at, plays: 0, mediaUrl: row.media_url, mediaType: row.media_type, readAloud: row.read_aloud, shapeType: row.shape_type, shapeColor: row.shape_color, timeLimitSeconds: row.time_limit_seconds, options: row.options })) });
});

router.post("/questions/bulk", verifyInstitutionToken, institutionCsvUpload.single("file"), async (req: InstitutionRequest, res) => {
  const placement = z.object({ levelId: z.string().uuid(), subject: z.string().trim().min(1).max(120).optional(), status: z.enum(["draft", "published"]).default("published") }).safeParse(req.body || {});
  if (!placement.success) return res.status(400).json({ success: false, message: "Choose a valid class for these questions." });
  if (!req.file || !req.file.originalname.toLowerCase().endsWith(".csv")) return res.status(400).json({ success: false, message: "Choose a CSV file to upload." });
  const parsed = parseInstitutionBulkQuestions(req.file.buffer.toString("utf8"));
  if (parsed.errors.length) return res.status(400).json({ success: false, errors: parsed.errors });
  const levelResult = await pool.query("SELECT id,name,subjects FROM institution_levels WHERE id=$1 AND institution_id=$2 AND is_active=true", [placement.data.levelId, req.institution!.id]);
  if (!levelResult.rows[0]) return res.status(404).json({ success: false, message: "The selected class could not be found in this institution." });
  const policyResult = await pool.query("SELECT publishing_policy FROM institutions WHERE id=$1", [req.institution!.id]);
  const autoPublish = policyResult.rows[0]?.publishing_policy === "auto_publish";
  const requestedPublish = placement.data.status === "published";
  const questionStatus = requestedPublish && autoPublish ? "published" : "draft";
  const reviewStatus = !requestedPublish ? "draft" : autoPublish ? "approved" : "pending";
  const subjects = Array.isArray(levelResult.rows[0].subjects) ? levelResult.rows[0].subjects : [];
  const subject = String(placement.data.subject || subjects[0] || levelResult.rows[0].name || "General").trim().slice(0, 120);
  if (subjects.length && !subjects.includes(subject)) return res.status(400).json({ success: false, message: "Choose a subject assigned to the selected class." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const questionRows = parsed.questions.map(item => ({ id: randomUUID(), text: cleanRichText(item.text), timeLimitSeconds: item.timeLimitSeconds }));
    const optionRows = parsed.questions.flatMap((item, questionIndex) => item.options.map((option, optionIndex) => ({ questionId: questionRows[questionIndex]!.id, optionIndex, text: cleanRichText(option), isCorrect: optionIndex === item.correct })));
    await client.query(
      `INSERT INTO institution_questions(id,institution_id,level_id,subject,question_text,explanation,status,review_status,time_limit_seconds)
       SELECT q.id,$2,$3,$4,q.question_text,'',$5,$6,q.time_limit_seconds
       FROM jsonb_to_recordset($1::jsonb) AS q(id uuid,question_text text,time_limit_seconds integer)`,
      [JSON.stringify(questionRows.map(item => ({ id: item.id, question_text: item.text, time_limit_seconds: item.timeLimitSeconds }))), req.institution!.id, placement.data.levelId, subject, questionStatus, reviewStatus],
    );
    await client.query(
      `INSERT INTO institution_question_options(question_id,option_order,option_text,is_correct)
       SELECT o.question_id,o.option_order,o.option_text,o.is_correct
       FROM jsonb_to_recordset($1::jsonb) AS o(question_id uuid,option_order integer,option_text text,is_correct boolean)`,
      [JSON.stringify(optionRows.map(option => ({ question_id: option.questionId, option_order: option.optionIndex, option_text: option.text, is_correct: option.isCorrect })))],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Institution bulk question upload failed", error);
    return res.status(500).json({ success: false, message: "No questions were uploaded. Please check the file and try again." });
  } finally { client.release(); }
  try { await logActivity({ eventType: "institution.questions_bulk_created", title: "Questions uploaded in bulk", description: `${parsed.questions.length} questions were added to ${levelResult.rows[0].name}`, metadata: { institutionId: req.institution!.id, levelId: placement.data.levelId, questionCount: parsed.questions.length, reviewStatus } }); }
  catch (error) { console.error("Institution bulk upload activity log failed", error); }
  const message = questionStatus === "published" ? `${parsed.questions.length} questions uploaded and published.` : requestedPublish ? `${parsed.questions.length} questions uploaded and sent for admin review.` : `${parsed.questions.length} questions uploaded as drafts.`;
  return res.status(201).json({ success: true, count: parsed.questions.length, message, status: questionStatus, reviewStatus });
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
  const institutionId = req.institution!.id;
  const pageValue = Number(req.query.page || 1);
  const page = Number.isFinite(pageValue) ? Math.max(1, Math.floor(pageValue)) : 1;
  const limit = 15;
  const levelIdValue = req.query.levelId ? z.string().uuid().safeParse(req.query.levelId) : null;
  if (levelIdValue && !levelIdValue.success) return res.status(400).json({ success: false, message: "Invalid class filter." });
  const categoryValue = z.enum(["all", "content", "access", "institution"]).safeParse(String(req.query.category || "all"));
  if (!categoryValue.success) return res.status(400).json({ success: false, message: "Invalid activity category." });
  const levelId = levelIdValue?.success ? levelIdValue.data : null;
  const category = categoryValue.data;
  const retentionResult = await pool.query("SELECT activity_retention_days FROM institutions WHERE id=$1", [institutionId]);
  const storedDays = Number(retentionResult.rows[0]?.activity_retention_days);
  const retentionDays = storedDays === 30 ? 30 : 15;
  const categorySql = `CASE WHEN event_type LIKE 'institution.question%' OR event_type LIKE '%level%' OR event_type LIKE '%category%' THEN 'content' WHEN event_type LIKE '%join%' OR event_type LIKE '%member%' THEN 'access' ELSE 'institution' END`;
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM activity_logs WHERE metadata->>'institutionId'=$1 AND created_at >= NOW() - ($3 * INTERVAL '1 day') AND ($2::uuid IS NULL OR metadata->>'levelId'=$2::text) AND ($4='all' OR (${categorySql})=$4)`, [institutionId, levelId, retentionDays, category]);
  const total = Number(count.rows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, totalPages);
  const [activities, latest] = await Promise.all([
    pool.query(`SELECT id,event_type,title,description,actor_name,metadata,created_at FROM activity_logs WHERE metadata->>'institutionId'=$1 AND created_at >= NOW() - ($3 * INTERVAL '1 day') AND ($2::uuid IS NULL OR metadata->>'levelId'=$2::text) AND ($4='all' OR (${categorySql})=$4) ORDER BY created_at DESC LIMIT $5 OFFSET $6`, [institutionId, levelId, retentionDays, category, limit, (currentPage - 1) * limit]),
    pool.query(`SELECT MAX(created_at) AS latest_at FROM activity_logs WHERE metadata->>'institutionId'=$1 AND created_at >= NOW() - ($3 * INTERVAL '1 day') AND ($2::uuid IS NULL OR metadata->>'levelId'=$2::text)`, [institutionId, levelId, retentionDays]),
  ]);
  return res.json({ success: true, activities: activities.rows, latestAt: latest.rows[0]?.latest_at || null, retentionDays, pagination: { page: currentPage, limit, total, totalPages } });
});

router.put("/activity-retention", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const parsed = InstitutionActivityRetentionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Choose a retention period of 15 or 30 days." });
  const institutionId = req.institution!.id;
  const updated = await pool.query("UPDATE institutions SET activity_retention_days=$2 WHERE id=$1 RETURNING activity_retention_days", [institutionId, parsed.data.retentionDays]);
  if (!updated.rows[0]) return res.status(404).json({ success: false, message: "Institution not found." });
  await purgeExpiredInstitutionActivity(institutionId);
  await logActivity({ eventType: "institution.activity_retention_updated", title: "Activity retention updated", description: `Institution activity will be kept for ${parsed.data.retentionDays} days.`, metadata: { institutionId, retentionDays: parsed.data.retentionDays } });
  return res.json({ success: true, retentionDays: Number(updated.rows[0].activity_retention_days) });
});
router.get("/dashboard", verifyInstitutionToken, async (req: InstitutionRequest, res) => {
  const institutionId = req.institution!.id;
  try {
    let retentionDays = 15;
    try {
      const retention = await pool.query("SELECT activity_retention_days FROM institutions WHERE id=$1", [institutionId]);
      retentionDays = Number(retention.rows[0]?.activity_retention_days) || retentionDays;
    } catch (error: any) {
      if (error?.code !== "42703") throw error;
      console.warn("Institution dashboard using default activity retention; activity_retention_days is not present yet.");
    }
    const [metrics, activities, requests] = await Promise.all([
      pool.query(`SELECT (SELECT COUNT(*)::int FROM institution_memberships WHERE institution_id=$1 AND status='active') students,(SELECT COUNT(*)::int FROM institution_questions WHERE institution_id=$1) questions,(SELECT COUNT(*)::int FROM institution_questions WHERE institution_id=$1 AND status='published') published_questions,(SELECT COUNT(*)::int FROM institution_memberships WHERE institution_id=$1 AND status='pending') pending_requests`, [institutionId]),
      pool.query(`SELECT id,event_type,title,description,actor_name,metadata,created_at FROM activity_logs WHERE metadata->>'institutionId'=$1 AND created_at >= NOW() - ($2 * INTERVAL '1 day') ORDER BY created_at DESC LIMIT 4`, [institutionId, retentionDays]),
      pool.query(`SELECT m.id,u.name,u.username,u.email,m.requested_at FROM institution_memberships m JOIN users u ON u.id=m.user_id WHERE m.institution_id=$1 AND m.status='pending' ORDER BY m.requested_at DESC LIMIT 5`, [institutionId]),
    ]);
    return res.json({ success: true, metrics: metrics.rows[0] || { students: 0, questions: 0, published_questions: 0, pending_requests: 0 }, activities: activities.rows, requests: requests.rows });
  } catch (error) {
    console.error("Institution dashboard request failed", error);
    return res.status(500).json({ success: false, message: "The institution dashboard could not be loaded. Please try again." });
  }
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
       (SELECT MAX(a.completed_at) FROM institution_question_attempts a WHERE a.user_id=u.id AND a.institution_id=m.institution_id AND a.completed_at IS NOT NULL) last_active
     FROM institution_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.id=$1 AND m.institution_id=$2 AND m.status='active'`,
    [parsedId.data, req.institution!.id],
  );
  if (!membership.rows[0]) return res.status(404).json({ success: false, message: "Student not found in this institution." });
  const userId = membership.rows[0].user_id;
  const [summary, activity] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int attempts,COUNT(*) FILTER (WHERE is_correct IS TRUE)::int passed,ROUND(AVG(CASE WHEN is_correct IS NOT NULL THEN CASE WHEN is_correct THEN 100.0 ELSE 0.0 END END))::int average_score FROM institution_question_attempts WHERE institution_id=$1 AND user_id=$2 AND completed_at IS NOT NULL`, [req.institution!.id, userId]),
    pool.query(`SELECT a.id,a.is_correct,a.timed_out,a.completed_at AS created_at,COALESCE(l.name,'Institution practice') level_name FROM institution_question_attempts a JOIN institution_questions q ON q.id=a.question_id AND q.institution_id=a.institution_id LEFT JOIN institution_levels l ON l.id=q.level_id WHERE a.institution_id=$1 AND a.user_id=$2 AND a.completed_at IS NOT NULL ORDER BY a.completed_at DESC LIMIT 10`, [req.institution!.id, userId]),
  ]);
  const row = membership.rows[0];
  return res.json({
    success: true,
    student: { id: row.id, name: row.name, username: row.username, email: row.email, phone: row.phone, age: row.age, totalXp: Number(row.total_xp || 0), status: row.status === "active" ? "Active" : row.status, joinedAt: row.joined_at, lastPracticeAt: row.last_active, initials: String(row.name || "IN").split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase() },
    summary: { attempts: Number(summary.rows[0]?.attempts || 0), passed: Number(summary.rows[0]?.passed || 0), averageScore: summary.rows[0]?.average_score == null ? null : Number(summary.rows[0].average_score) },
    recentActivity: activity.rows.map((item: Record<string, any>) => ({ id: item.id, activity: item.timed_out ? "Timed out" : item.is_correct ? "Passed practice" : "Completed practice", levelName: item.level_name, score: item.is_correct === null ? 0 : item.is_correct ? 100 : 0, passed: item.is_correct === true, createdAt: item.created_at })),
  });
});
router.get("/my-learning/:institutionId", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.institutionId);
  if (!parsedId.success) return res.status(404).json({ success: false, message: "Institution not found." });
  const playerId = req.user!.id;
  const membership = await pool.query(
    `SELECT i.id,i.name,i.institution_type,i.city,i.state,i.questions_per_play,s.category_label,s.level_label,s.learner_label,s.subject_label
     FROM institution_memberships m JOIN institutions i ON i.id=m.institution_id LEFT JOIN institution_structure_settings s ON s.institution_id=i.id
     WHERE m.user_id=$1 AND m.institution_id=$2 AND m.status='active' AND i.is_active=true`,
    [playerId, parsedId.data],
  );
  if (!membership.rows[0]) return res.status(404).json({ success: false, message: "Active institution membership not found." });
  const [levels, areas] = await Promise.all([
    pool.query(`SELECT l.id,l.name,l.code,l.subjects,c.name category_name FROM institution_levels l JOIN institution_categories c ON c.id=l.category_id WHERE l.institution_id=$1 AND l.is_active=true AND c.is_active=true ORDER BY c.sort_order,l.sort_order,l.name`, [parsedId.data]),
    pool.query(`SELECT q.level_id,COALESCE(NULLIF(BTRIM(q.subject),''),'General') subject,COUNT(*)::int question_count FROM institution_questions q JOIN institution_levels l ON l.id=q.level_id AND l.is_active=true JOIN institution_categories c ON c.id=l.category_id AND c.is_active=true WHERE q.institution_id=$1 AND q.status='published' GROUP BY q.level_id,COALESCE(NULLIF(BTRIM(q.subject),''),'General') ORDER BY q.level_id,subject`, [parsedId.data]),
  ]);
  return res.json({
    success: true,
    institution: { id: membership.rows[0].id, name: membership.rows[0].name, institutionType: membership.rows[0].institution_type, city: membership.rows[0].city, state: membership.rows[0].state, questionsPerPlay: Number(membership.rows[0].questions_per_play || 10) },
    labels: { category: membership.rows[0].category_label || "Section", level: membership.rows[0].level_label || "Class", learner: membership.rows[0].learner_label || "Learners", subject: membership.rows[0].subject_label || "Learning areas" },
    levels: levels.rows.map((row: Record<string, any>) => ({ id: row.id, name: row.name, code: row.code, category: row.category_name, subjects: Array.isArray(row.subjects) ? row.subjects : [] })),
    learningAreas: areas.rows.map((row: Record<string, any>) => ({ levelId: row.level_id, name: row.subject, questionCount: Number(row.question_count || 0) })),
  });
});


router.post("/my-learning/:institutionId/practice", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const institutionId = z.string().uuid().safeParse(req.params.institutionId);
  const parsed = InstitutionPracticeStartSchema.safeParse(req.body || {});
  if (!institutionId.success || !parsed.success) return res.status(400).json({ success: false, message: "Choose a valid learning placement and area." });
  const playerId = req.user!.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const membership = await client.query(
      `SELECT i.questions_per_play FROM institutions i JOIN institution_memberships m ON m.institution_id=i.id
       WHERE i.id=$1 AND i.is_active=true AND m.user_id=$2 AND m.status='active'`,
      [institutionId.data, playerId],
    );
    if (!membership.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Active institution membership not found." }); }
    const result = await client.query(
      `SELECT q.id,q.level_id,COALESCE(NULLIF(BTRIM(q.subject),''),'General') subject,q.question_text,q.media_url,q.media_type,q.read_aloud,q.shape_type,q.shape_color,q.time_limit_seconds,
              COALESCE((SELECT json_agg(json_build_object('text',o.option_text,'mediaUrl',o.media_url,'mediaType',o.media_type,'shapeType',o.shape_type,'shapeColor',o.shape_color) ORDER BY o.option_order)
                        FROM institution_question_options o WHERE o.question_id=q.id),'[]') options
       FROM (SELECT q.* FROM institution_questions q JOIN institution_levels l ON l.id=q.level_id AND l.is_active=true JOIN institution_categories c ON c.id=l.category_id AND c.is_active=true WHERE q.institution_id=$1 AND q.level_id=$2 AND COALESCE(NULLIF(BTRIM(q.subject),''),'General')=$3 AND q.status='published' ORDER BY random() LIMIT $4) q
       ORDER BY random()`,
      [institutionId.data, parsed.data.levelId, parsed.data.subject, Number(membership.rows[0].questions_per_play) || 10],
    );
    if (!result.rowCount) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "No published questions are available in this learning area yet." }); }
    const stateResult = await client.query(
      `SELECT u.coins_count,u.lives_remaining,s.max_lives,s.passing_score_percent,s.refill_coin_cost
       FROM users u CROSS JOIN gameplay_settings s WHERE u.id=$1 AND s.id=1 FOR UPDATE OF u`,
      [playerId],
    );
    const state = stateResult.rows[0];
    if (!state) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Player gameplay settings could not be loaded." }); }
    let livesRemaining = Number(state.lives_remaining), coinBalance = Number(state.coins_count), refilled = false;
    const maxLives = Number(state.max_lives), refillCoinCost = Number(state.refill_coin_cost);
    if (livesRemaining <= 0) {
      if (coinBalance < refillCoinCost) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, code: "NO_LIVES", message: "You have no lives remaining and not enough coins to refill them. Please wait for lives to restore or get more coins.", livesRemaining: 0, coinBalance, maxLives, refillCoinCost });
      }
      const transaction = await recordCoinTransaction({ userId: playerId, type: "deduction", amount: refillCoinCost, description: `Automatic refill to ${maxLives} lives before institution practice`, reference: `life-refill:institution:${randomUUID()}`, metadata: { institutionId: institutionId.data, levelId: parsed.data.levelId, kind: "institution_practice_refill" } }, client);
      coinBalance = Number(transaction.balance_after);
      livesRemaining = maxLives;
      refilled = true;
      await client.query("UPDATE users SET lives_remaining=$1,updated_at=NOW() WHERE id=$2", [livesRemaining, playerId]);
    }
    const playId = randomUUID();
    const questionIds = result.rows.map((row: Record<string, any>) => row.id);
    await client.query(
      `INSERT INTO institution_practice_plays(id,institution_id,user_id,level_id,subject,question_ids,expected_question_count)
       VALUES($1,$2,$3,$4,$5,$6::uuid[],$7)`,
      [playId, institutionId.data, playerId, parsed.data.levelId, parsed.data.subject, questionIds, questionIds.length],
    );
    await client.query("COMMIT");
    return res.json({ success: true, play: { id: playId }, gameplay: { livesRemaining, maxLives, coinBalance, passingScorePercent: Number(state.passing_score_percent), refillCoinCost, refilled }, questions: result.rows.map((row: Record<string, any>) => ({ id: row.id, levelId: row.level_id, subject: row.subject, text: row.question_text, mediaUrl: row.media_url, mediaType: row.media_type, readAloud: row.read_aloud, shapeType: row.shape_type, shapeColor: row.shape_color, timeLimitSeconds: row.time_limit_seconds, options: row.options })) });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});
router.post("/my-learning/:institutionId/practice/review", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const institutionId = z.string().uuid().safeParse(req.params.institutionId);
  const parsed = InstitutionPracticeReviewSchema.safeParse(req.body || {});
  if (!institutionId.success || !parsed.success) return res.status(400).json({ success: false, message: "This practice review could not be loaded." });
  const attemptIds = [...new Set(parsed.data.attemptIds)];
  const result = await pool.query(
    `SELECT a.id AS attempt_id,a.question_id,a.selected_option_order,a.is_correct,a.timed_out,
            q.explanation,
            (SELECT o.option_order FROM institution_question_options o WHERE o.question_id=q.id AND o.is_correct=true LIMIT 1) AS correct_option_order
     FROM institution_question_attempts a
     JOIN institution_questions q ON q.id=a.question_id AND q.institution_id=a.institution_id
     WHERE a.id=ANY($1::uuid[]) AND a.institution_id=$2 AND a.user_id=$3
       AND a.completed_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM institutions i WHERE i.id=$2 AND i.is_active=true)
       AND EXISTS (SELECT 1 FROM institution_memberships m WHERE m.institution_id=$2 AND m.user_id=$3 AND m.status='active')`,
    [attemptIds, institutionId.data, req.user!.id],
  );
  return res.json({ success: true, reviews: result.rows.map((row: Record<string, any>) => ({ attemptId: row.attempt_id, questionId: row.question_id, selectedOptionOrder: row.selected_option_order === null ? null : Number(row.selected_option_order), correctOptionOrder: row.correct_option_order === null ? null : Number(row.correct_option_order), correct: row.is_correct, timedOut: Boolean(row.timed_out), explanation: row.explanation || "" })) });
});
router.post("/my-learning/:institutionId/practice/complete", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const institutionId = z.string().uuid().safeParse(req.params.institutionId);
  const parsed = z.object({ playId: z.string().uuid() }).safeParse(req.body || {});
  if (!institutionId.success || !parsed.success) return res.status(400).json({ success: false, message: "This practice play could not be saved." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stateResult = await client.query(
      `SELECT p.*,u.coins_count,u.lives_remaining,s.max_lives,s.passing_score_percent,s.refill_coin_cost
       FROM institution_practice_plays p JOIN users u ON u.id=p.user_id CROSS JOIN gameplay_settings s
       WHERE p.id=$1 AND p.institution_id=$2 AND p.user_id=$3 AND s.id=1
         AND EXISTS (SELECT 1 FROM institutions i WHERE i.id=$2 AND i.is_active=true)
         AND EXISTS (SELECT 1 FROM institution_memberships m WHERE m.institution_id=$2 AND m.user_id=$3 AND m.status='active')
       FOR UPDATE OF p,u`,
      [parsed.data.playId, institutionId.data, req.user!.id],
    );
    const play = stateResult.rows[0];
    if (!play) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "This practice play could not be found." }); }
    if (play.completed_at) {
      await client.query("COMMIT");
      return res.json({ success: true, replayed: true, passed: Boolean(play.passed), scorePercent: Number(play.score_percent), correctAnswers: Number(play.correct_count), totalQuestions: Number(play.expected_question_count), lifeLost: Boolean(play.life_lost), livesRemaining: Number(play.lives_after), coinBalance: Number(play.coin_balance_after), maxLives: Number(play.max_lives), refillCoinCost: Number(play.refill_coin_cost), refilled: Boolean(play.refilled), needsPurchase: Boolean(play.life_lost) && Number(play.lives_after) === 0 });
    }
    const attemptResult = await client.query(
      `SELECT COUNT(*)::int AS completed,COUNT(*) FILTER (WHERE is_correct IS TRUE)::int AS correct
       FROM institution_question_attempts WHERE play_id=$1 AND institution_id=$2 AND user_id=$3 AND completed_at IS NOT NULL`,
      [parsed.data.playId, institutionId.data, req.user!.id],
    );
    const completedCount = Number(attemptResult.rows[0]?.completed || 0);
    const expectedCount = Number(play.expected_question_count);
    if (completedCount !== expectedCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, code: "PRACTICE_INCOMPLETE", message: "Finish every question in this play before submitting your result." });
    }
    const correctCount = Number(attemptResult.rows[0]?.correct || 0);
    const scorePercent = Math.round(correctCount * 100 / expectedCount);
    const passed = scorePercent >= Number(play.passing_score_percent);
    let livesRemaining = Number(play.lives_remaining), coinBalance = Number(play.coins_count), refilled = false;
    if (!passed) {
      livesRemaining = Math.max(0, livesRemaining - 1);
      if (livesRemaining === 0 && coinBalance >= Number(play.refill_coin_cost)) {
        const refill = await recordCoinTransaction({ userId: req.user!.id, type: "deduction", amount: Number(play.refill_coin_cost), description: `Automatic refill to ${play.max_lives} lives after a failed institution practice`, reference: `life-refill:institution:${parsed.data.playId}`, metadata: { institutionId: institutionId.data, levelId: play.level_id, playId: parsed.data.playId, kind: "institution_practice_refill" } }, client);
        coinBalance = Number(refill.balance_after);
        livesRemaining = Number(play.max_lives);
        refilled = true;
      }
      await client.query("UPDATE users SET lives_remaining=$1,updated_at=NOW() WHERE id=$2", [livesRemaining, req.user!.id]);
    }
    await client.query(
      `UPDATE institution_practice_plays SET completed_at=NOW(),correct_count=$2,score_percent=$3,passed=$4,life_lost=$5,lives_after=$6,coin_balance_after=$7,refilled=$8 WHERE id=$1`,
      [parsed.data.playId, correctCount, scorePercent, passed, !passed, livesRemaining, coinBalance, refilled],
    );
    await client.query("UPDATE institution_question_attempts SET play_completed_at=NOW() WHERE play_id=$1 AND institution_id=$2 AND user_id=$3", [parsed.data.playId, institutionId.data, req.user!.id]);
    await client.query("COMMIT");
    return res.json({ success: true, passed, scorePercent, correctAnswers: correctCount, totalQuestions: expectedCount, passingScorePercent: Number(play.passing_score_percent), lifeLost: !passed, livesRemaining, maxLives: Number(play.max_lives), coinBalance, refillCoinCost: Number(play.refill_coin_cost), refilled, needsPurchase: !passed && livesRemaining === 0 });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

router.get("/my-learning/:institutionId/history", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.institutionId);
  if (!parsedId.success) return res.status(404).json({ success: false, message: "Institution not found." });
  const playerId = req.user!.id;
  const membership = await pool.query(
    `SELECT 1 FROM institution_memberships m JOIN institutions i ON i.id=m.institution_id
     WHERE m.user_id=$1 AND m.institution_id=$2 AND m.status='active' AND i.is_active=true`,
    [playerId, parsedId.data],
  );
  if (!membership.rows[0]) return res.status(404).json({ success: false, message: "Active institution membership not found." });
  const requestedPage = Number(req.query.page);
  const requestedLimit = Number(req.query.limit);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(50, requestedLimit) : 10;
  const offset = (page - 1) * limit;
  await purgeExpiredInstitutionLearningHistory();
  const [count, plays] = await Promise.all([
    pool.query(
      `SELECT (SELECT COUNT(*) FROM institution_practice_plays WHERE institution_id=$1 AND user_id=$2 AND completed_at IS NOT NULL)
            + (SELECT COUNT(*) FROM institution_question_attempts WHERE institution_id=$1 AND user_id=$2 AND play_id IS NULL AND completed_at IS NOT NULL) AS total`,
      [parsedId.data, playerId],
    ),
    pool.query(
      `WITH all_plays AS (
         SELECT p.id AS play_id,p.started_at,p.completed_at,p.subject,l.name AS level_name,
                p.expected_question_count AS question_count,p.correct_count,p.question_ids,false AS legacy
         FROM institution_practice_plays p LEFT JOIN institution_levels l ON l.id=p.level_id
         WHERE p.institution_id=$1 AND p.user_id=$2 AND p.completed_at IS NOT NULL
         UNION ALL
         SELECT a.id,a.started_at,a.completed_at,COALESCE(NULLIF(BTRIM(q.subject),''),'General'),l.name,
                1,CASE WHEN a.is_correct IS TRUE THEN 1 ELSE 0 END,ARRAY[q.id]::uuid[],true
         FROM institution_question_attempts a
         JOIN institution_questions q ON q.id=a.question_id AND q.institution_id=a.institution_id
         LEFT JOIN institution_levels l ON l.id=q.level_id
         WHERE a.institution_id=$1 AND a.user_id=$2 AND a.play_id IS NULL AND a.completed_at IS NOT NULL
       ), selected_plays AS (
         SELECT * FROM all_plays ORDER BY completed_at DESC,play_id DESC LIMIT $3 OFFSET $4
       )
       SELECT p.play_id,p.started_at,p.completed_at,p.subject,p.level_name,p.question_count,p.correct_count,
              COALESCE(details.attempts,'[]'::json) AS attempts
       FROM selected_plays p
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
           'id',a.id,'question',q.question_text,'selectedOption',o.option_text,
           'correct',a.is_correct,'timedOut',a.timed_out,'startedAt',a.started_at,'completedAt',a.completed_at
         ) ORDER BY a.started_at,a.id) AS attempts
         FROM institution_question_attempts a
         JOIN institution_questions q ON q.id=a.question_id AND q.institution_id=a.institution_id
         LEFT JOIN institution_question_options o ON o.question_id=a.question_id AND o.option_order=a.selected_option_order
         WHERE a.institution_id=$1 AND a.user_id=$2 AND a.completed_at IS NOT NULL
           AND ((p.legacy AND a.id=p.play_id AND a.play_id IS NULL) OR (NOT p.legacy AND a.play_id=p.play_id AND a.play_completed_at IS NOT NULL))
       ) details ON true
       ORDER BY p.completed_at DESC,p.play_id DESC`,
      [parsedId.data, playerId, limit, offset],
    ),
  ]);
  return res.json({
    success: true,
    plays: plays.rows.map((play: Record<string, any>) => ({
      id: play.play_id,
      subject: play.subject,
      level: play.level_name,
      startedAt: play.started_at,
      completedAt: play.completed_at,
      questionCount: Number(play.question_count || 0),
      correctCount: Number(play.correct_count || 0),
      attempts: Array.isArray(play.attempts) ? play.attempts.map((attempt: Record<string, any>) => ({ ...attempt, timedOut: Boolean(attempt.timedOut) })) : [],
    })),
    pagination: { page, limit, total: Number(count.rows[0]?.total || 0) },
  });
});

router.post("/my-learning/:institutionId/questions/:questionId/start", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const institutionId = z.string().uuid().safeParse(req.params.institutionId);
  const questionId = z.string().uuid().safeParse(req.params.questionId);
  const parsedKey = z.object({ attemptKey: z.string().uuid(), playId: z.string().uuid() }).safeParse(req.body || {});
  if (!institutionId.success || !questionId.success || !parsedKey.success) return res.status(400).json({ success: false, message: "This question session could not be started." });
  const playerId = req.user!.id;
  const playerState = await pool.query("SELECT lives_remaining FROM users WHERE id=$1", [playerId]);
  if (!playerState.rows[0]) return res.status(404).json({ success: false, message: "Player not found." });
  if (Number(playerState.rows[0].lives_remaining) <= 0) return res.status(409).json({ success: false, code: "NO_LIVES", message: "You have no lives remaining. Restore your lives before continuing." });
  const attempt = await pool.query(
    `WITH inserted AS (
       INSERT INTO institution_question_attempts(question_id,institution_id,user_id,attempt_key,started_at,expires_at,play_id)
       SELECT q.id,q.institution_id,$4,$3,NOW(),NOW() + (q.time_limit_seconds * INTERVAL '1 second'),$5
       FROM institution_questions q
       WHERE q.id=$1 AND q.institution_id=$2 AND q.status='published'
         AND EXISTS (SELECT 1 FROM institutions i WHERE i.id=$2 AND i.is_active=true)
         AND EXISTS (SELECT 1 FROM institution_memberships m WHERE m.institution_id=$2 AND m.user_id=$4 AND m.status='active')
         AND EXISTS (SELECT 1 FROM institution_practice_plays p WHERE p.id=$5 AND p.institution_id=$2 AND p.user_id=$4 AND p.completed_at IS NULL AND q.id=ANY(p.question_ids))
         AND NOT EXISTS (SELECT 1 FROM institution_question_attempts a WHERE a.question_id=q.id AND a.user_id=$4 AND a.completed_at IS NULL)
       ON CONFLICT(user_id,question_id,attempt_key) DO UPDATE SET attempt_key=EXCLUDED.attempt_key
       RETURNING id,started_at,expires_at
     )
     SELECT id,started_at,expires_at FROM inserted
     UNION ALL
     SELECT a.id,a.started_at,a.expires_at FROM institution_question_attempts a
     JOIN institution_questions q ON q.id=a.question_id AND q.institution_id=a.institution_id AND q.status='published'
     WHERE a.question_id=$1 AND a.institution_id=$2 AND a.user_id=$4 AND a.completed_at IS NULL AND a.play_id=$5
       AND EXISTS (SELECT 1 FROM institutions i WHERE i.id=$2 AND i.is_active=true)
       AND EXISTS (SELECT 1 FROM institution_memberships m WHERE m.institution_id=$2 AND m.user_id=$4 AND m.status='active')
     ORDER BY started_at DESC LIMIT 1`,
    [questionId.data, institutionId.data, parsedKey.data.attemptKey, playerId, parsedKey.data.playId],
  );
  if (!attempt.rows[0]) return res.status(404).json({ success: false, message: "Published question not found." });
  return res.json({ success: true, attempt: attempt.rows[0] });
});

router.post("/my-learning/:institutionId/questions/:questionId/action", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const institutionId = z.string().uuid().safeParse(req.params.institutionId);
  const questionId = z.string().uuid().safeParse(req.params.questionId);
  const action = z.object({
    actionId: z.string().uuid(), playId: z.string().uuid(), attemptId: z.string().uuid(),
    eventKey: z.enum(["question_skipped", "wrong_option_removed", "answer_revealed"]),
  }).safeParse(req.body || {});
  if (!institutionId.success || !questionId.success || !action.success) return res.status(400).json({ success: false, message: "This lifeline could not be used." });
  const playerId = req.user!.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const actionKey = `${playerId}:${action.data.playId}:${questionId.data}:${action.data.eventKey}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [actionKey]);
    const duplicate = await client.query(
      `SELECT 1 FROM coin_transactions WHERE user_id=$1 AND metadata->>'institutionPlayId'=$2
       AND metadata->>'questionId'=$3 AND metadata->>'eventKey'=$4 LIMIT 1`,
      [playerId, action.data.playId, questionId.data, action.data.eventKey],
    );
    if (duplicate.rowCount) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "You have already used this lifeline for this question." }); }
    const state = await client.query(
      `SELECT u.coins_count,u.lives_remaining,a.id attempt_id,a.expires_at,a.completed_at
       FROM users u JOIN institution_practice_plays p ON p.user_id=u.id
       JOIN institution_question_attempts a ON a.play_id=p.id AND a.question_id=$3 AND a.id=$4 AND a.user_id=u.id
       WHERE u.id=$1 AND p.id=$2 AND p.institution_id=$5 AND p.completed_at IS NULL AND a.completed_at IS NULL
         AND a.expires_at>NOW() AND EXISTS (SELECT 1 FROM institutions i WHERE i.id=$5 AND i.is_active=true)
         AND EXISTS (SELECT 1 FROM institution_memberships m WHERE m.institution_id=$5 AND m.user_id=$1 AND m.status='active')
       FOR UPDATE OF u,p,a`,
      [playerId, action.data.playId, questionId.data, action.data.attemptId, institutionId.data],
    );
    if (!state.rows[0]) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, code: "QUESTION_ATTEMPT_INACTIVE", message: "Start an active question before using a lifeline." }); }
    if (Number(state.rows[0].lives_remaining) <= 0) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, code: "NO_LIVES", message: "You have no lives remaining. Restore your lives before using a lifeline." }); }
    const ruleResult = await client.query("SELECT * FROM coin_rules WHERE event_key=$1 AND type='deduction' AND is_active=true", [action.data.eventKey]);
    const rule = ruleResult.rows[0];
    if (!rule) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, code: "RULE_INACTIVE", message: "This lifeline is not currently available." }); }
    const options = await client.query(
      `SELECT o.option_order,o.is_correct FROM institution_questions q
       JOIN institution_question_options o ON o.question_id=q.id
       WHERE q.id=$1 AND q.institution_id=$2 AND q.status='published' ORDER BY o.option_order`,
      [questionId.data, institutionId.data],
    );
    if (!options.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Question options could not be loaded." }); }
    const transaction = await recordCoinTransaction({
      userId: playerId, type: "deduction", amount: Number(rule.amount), description: rule.description || rule.name,
      reference: `institution-game-action:${action.data.actionId}`, ruleId: rule.id,
      metadata: { eventKey: action.data.eventKey, institutionId: institutionId.data, institutionPlayId: action.data.playId, questionId: questionId.data },
    }, client);
    let effect: Record<string, unknown> = {};
    if (action.data.eventKey === "answer_revealed") effect = { correctOptionOrder: options.rows.find((option: { is_correct: boolean }) => option.is_correct)?.option_order };
    if (action.data.eventKey === "wrong_option_removed") {
      const incorrect = options.rows.filter((option: { is_correct: boolean }) => !option.is_correct);
      if (!incorrect.length) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "There is no incorrect option to remove." }); }
      effect = { removedOptionOrder: incorrect[Math.floor(Math.random() * incorrect.length)].option_order };
    }
    if (action.data.eventKey === "question_skipped") {
      await client.query("UPDATE institution_question_attempts SET completed_at=NOW(),timed_out=false,is_correct=NULL,selected_option_order=NULL WHERE id=$1 AND completed_at IS NULL", [action.data.attemptId]);
    }
    await client.query("COMMIT");
    return res.status(201).json({ success: true, eventKey: action.data.eventKey, amountDeducted: Number(rule.amount), coinBalance: Number(transaction.balance_after), ...effect });
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return res.status(409).json({ success: false, message: "This lifeline was already used." });
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    throw error;
  } finally { client.release(); }
});

router.post("/my-learning/:institutionId/questions/:questionId/answer", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const institutionId = z.string().uuid().safeParse(req.params.institutionId);
  const questionId = z.string().uuid().safeParse(req.params.questionId);
  const answer = z.object({ optionIndex: z.coerce.number().int().min(0).max(3), attemptId: z.string().uuid() }).safeParse(req.body || {});
  if (!institutionId.success || !questionId.success || !answer.success) return res.status(400).json({ success: false, message: "Start this question before submitting an answer." });
  const playerId = req.user!.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const playerState = await client.query("SELECT lives_remaining FROM users WHERE id=$1 FOR UPDATE", [playerId]);
    if (!playerState.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Player not found." }); }
    if (Number(playerState.rows[0].lives_remaining) <= 0) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, code: "NO_LIVES", message: "You have no lives remaining. Restore your lives before answering." }); }
    const result = await client.query(
    `SELECT o.is_correct,q.explanation,a.expires_at,a.completed_at
     FROM institution_questions q JOIN institution_question_options o ON o.question_id=q.id AND o.option_order=$3
     JOIN institution_question_attempts a ON a.question_id=q.id AND a.institution_id=q.institution_id AND a.id=$5 AND a.user_id=$4
     WHERE q.id=$1 AND q.institution_id=$2 AND q.status='published'
       AND EXISTS (SELECT 1 FROM institutions i WHERE i.id=$2 AND i.is_active=true)
       AND EXISTS (SELECT 1 FROM institution_memberships m WHERE m.institution_id=$2 AND m.user_id=$4 AND m.status='active')
     FOR UPDATE OF a`,
    [questionId.data, institutionId.data, answer.data.optionIndex, playerId, answer.data.attemptId],
  );
  if (!result.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Published question not found." }); }
  if (result.rows[0].completed_at) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, code: "QUESTION_ATTEMPT_COMPLETE", message: "This question attempt is already complete." }); }
  if (Date.now() >= new Date(result.rows[0].expires_at).getTime()) {
    await client.query("UPDATE institution_question_attempts SET completed_at=NOW(),timed_out=true,is_correct=NULL,selected_option_order=NULL WHERE id=$1", [answer.data.attemptId]);
    await client.query("COMMIT");
    return res.status(408).json({ success: false, code: "QUESTION_TIME_EXPIRED", message: "This question's time limit has ended." });
  }
  const correct = Boolean(result.rows[0].is_correct);
  await client.query(
    "UPDATE institution_question_attempts SET selected_option_order=$2,is_correct=$3,timed_out=false,completed_at=CASE WHEN $3 THEN NOW() ELSE NULL END WHERE id=$1 AND completed_at IS NULL",
    [answer.data.attemptId, answer.data.optionIndex, correct],
  );
  await client.query("COMMIT");
  return res.json({ success: true, correct, explanation: correct ? result.rows[0].explanation : null });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});

router.post("/my-learning/:institutionId/questions/:questionId/finish", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const institutionId = z.string().uuid().safeParse(req.params.institutionId);
  const questionId = z.string().uuid().safeParse(req.params.questionId);
  const attempt = z.object({ attemptId: z.string().uuid(), timedOut: z.boolean().optional().default(false) }).safeParse(req.body || {});
  if (!institutionId.success || !questionId.success || !attempt.success) return res.status(400).json({ success: false, message: "This question session could not be completed." });
  const playerId = req.user!.id;
  const finished = await pool.query(
    `UPDATE institution_question_attempts a SET completed_at=COALESCE(a.completed_at,NOW()),
       timed_out=CASE WHEN $5 THEN true ELSE a.timed_out END,
       is_correct=CASE WHEN $5 THEN NULL ELSE a.is_correct END,
       selected_option_order=CASE WHEN $5 THEN NULL ELSE a.selected_option_order END
     FROM institution_questions q
     WHERE a.id=$1 AND a.question_id=$2 AND a.institution_id=$3 AND a.user_id=$4
       AND q.id=a.question_id AND q.institution_id=a.institution_id
       AND EXISTS (SELECT 1 FROM institutions i WHERE i.id=$3 AND i.is_active=true)
       AND EXISTS (SELECT 1 FROM institution_memberships m WHERE m.institution_id=$3 AND m.user_id=$4 AND m.status='active')
     RETURNING a.id`,
    [attempt.data.attemptId, questionId.data, institutionId.data, playerId, attempt.data.timedOut],
  );
  if (!finished.rows[0]) return res.status(404).json({ success: false, message: "Question attempt not found." });
  return res.json({ success: true });
});

router.get("/my-learning", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const playerId = req.user!.id;
  const memberships = await pool.query(`SELECT m.id,m.status,m.source,m.requested_at,m.approved_at,i.id institution_id,i.name institution_name,i.institution_type,i.city,i.state,i.country FROM institution_memberships m JOIN institutions i ON i.id=m.institution_id WHERE m.user_id=$1 ORDER BY m.requested_at DESC`, [playerId]);
  return res.json({ success: true, memberships: memberships.rows });
});

router.post("/:id/join-requests", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const parsed = JoinSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, message: "Enter a valid institution code." });
  const playerId = req.user!.id;
  const institution = await pool.query("SELECT id,name,is_public,invite_code FROM institutions WHERE id=$1 AND is_active=true", [req.params.id]);
  if (!institution.rows[0]) return res.status(404).json({ success: false, message: "Institution not found." });
  const target = institution.rows[0];
  const suppliedCode = String(parsed.data.inviteCode || "").trim().toUpperCase();
  if (!target.is_public && suppliedCode !== target.invite_code) return res.status(403).json({ success: false, message: "This institution is invite-only. Enter its correct invitation code." });
  const source = suppliedCode ? "invite_code" : "public";
  try {
    const existing = await pool.query("SELECT id,status FROM institution_memberships WHERE institution_id=$1 AND user_id=$2", [target.id, playerId]);
    if (existing.rows[0]?.status === "active") return res.status(409).json({ success: false, message: "This player profile already belongs to the institution." });
    if (existing.rows[0]?.status === "pending") return res.status(409).json({ success: false, message: "Your request is already waiting for institution approval." });
    const membership = existing.rows[0]
      ? await pool.query("UPDATE institution_memberships SET status='pending',source=$1,requested_at=NOW(),approved_at=NULL WHERE id=$2 RETURNING id,status,requested_at", [source, existing.rows[0].id])
      : await pool.query("INSERT INTO institution_memberships(institution_id,user_id,status,source) VALUES($1,$2,'pending',$3) RETURNING id,status,requested_at", [target.id, playerId, source]);
    await logActivity({ eventType: "institution.join_requested", title: "Institution join request", description: `A player requested to join ${target.name}`, actorId: playerId, metadata: { institutionId: target.id, membershipId: membership.rows[0].id, source } });
    return res.status(201).json({ success: true, message: `Your request to join ${target.name} has been sent.`, membership: { ...membership.rows[0], institution: institutionShape(target) } });
  } catch (error) {
    console.error("Institution join request failed", error);
    return res.status(500).json({ success: false, message: "Your join request could not be submitted." });
  }
});

router.get("/my-memberships", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const playerId = req.user!.id;
  const result = await pool.query(
    `SELECT m.id,m.status,m.source,m.requested_at,m.approved_at,i.id institution_id,i.name,i.institution_type,i.city,i.state,i.country
     FROM institution_memberships m JOIN institutions i ON i.id=m.institution_id
     WHERE m.user_id=$1 ORDER BY m.requested_at DESC`, [playerId],
  );
  return res.json({ success: true, memberships: result.rows });
});

router.delete("/my-memberships/:id", verifyPlayerToken, async (req: AuthenticatedRequest, res) => {
  const playerId = req.user!.id;
  try {
    const result = await pool.query(
      `DELETE FROM institution_memberships
       WHERE id=$1 AND user_id=$2 AND status='pending'
       RETURNING id,institution_id`,
      [req.params.id, playerId],
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Only pending join requests can be canceled." });
    await logActivity({
      eventType: "institution.join_request_canceled",
      title: "Institution join request canceled",
      description: "A player canceled their pending institution join request",
      actorId: playerId,
      metadata: { institutionId: result.rows[0].institution_id, membershipId: result.rows[0].id },
    });
    return res.json({ success: true, message: "Your institution request was canceled." });
  } catch (error) {
    console.error("Institution join request cancellation failed", { requestId: req.params.id, playerId, error });
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
