import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import pool from "../config/database_connection";
import { logActivity } from "../helpers/activityLog";
import { verifyAdminToken } from "../middlewares/authentication_middleware";
import { generateQuestionDrafts } from "../services/ai_question_service";
import { destroyMediaQuietly, StoredMedia, uploadMedia } from "../services/cloudinary_media_service";

const router = Router();
const allowedMimeTypes: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg",
  "video/mp4": ".mp4", "video/webm": ".webm",
  "application/pdf": ".pdf",
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, done) => allowedMimeTypes[file.mimetype] ? done(null, true) : done(new Error("Unsupported media type.")),
});
const fields = [{ name: "questionMedia", maxCount: 1 }, ...Array.from({ length: 4 }, (_, index) => ({ name: `optionMedia${index}`, maxCount: 1 }))];
const shapeSchema = z.object({ type: z.enum(["circle", "square", "rectangle", "triangle", "star", "hexagon"]), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).nullable().optional();
const optionSchema = z.object({ text: z.string().trim().max(5000), isCorrect: z.boolean(), mediaType: z.enum(["image", "audio", "video", "document"]).nullable().optional(), shape: shapeSchema });
const bodySchema = z.object({
  questionText: z.string().trim().max(10000).default(""), explanation: z.string().trim().max(5000).default(""), shape: z.string().default("null").transform((value, ctx) => { try { return shapeSchema.parse(JSON.parse(value)); } catch { ctx.addIssue({ code: "custom", message: "Invalid question shape." }); return z.NEVER; } }),
  ageGroupId: z.string().uuid(), categoryId: z.string().uuid(), levelId: z.string().uuid(),
  status: z.enum(["draft", "published"]).default("published"),
  questionMediaType: z.enum(["", "image", "audio", "video", "document"]).default(""),
  options: z.string().transform((value, ctx) => { try { return z.array(optionSchema).length(4).parse(JSON.parse(value)); } catch { ctx.addIssue({ code: "custom", message: "Four valid options are required." }); return z.NEVER; } }),
});
const storeFiles = async (fileMap: Record<string, Express.Multer.File[]>) => {
  const entries = await Promise.all(Object.entries(fileMap).map(async ([field, files]) => [field, await Promise.all(files.map(uploadMedia))] as const));
  return Object.fromEntries(entries) as Record<string, StoredMedia[]>;
};
const storedMedia = (fileMap: Record<string, StoredMedia[]>, field: string) => fileMap[field]?.[0];
const cleanupStored = (fileMap: Record<string, StoredMedia[]>) => Promise.all(Object.values(fileMap).flat().map(destroyMediaQuietly));
const cleanRichText = (value: string) => sanitizeHtml(value, { allowedTags: ["p","br","strong","b","em","i","u","s","ul","ol","li","div"], allowedAttributes: { div: ["style"], p: ["style"] }, allowedStyles: { "*": { "text-align": [/^left$/, /^center$/, /^right$/] } } });
const plainText = (value: string) => sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).replace(/&nbsp;/g, " ").trim();
const generationSchema = z.object({
  ageGroupId: z.string().uuid(), categoryId: z.string().uuid(), levelId: z.string().uuid(),
  count: z.number().int().min(1).max(20).default(5),
  guidance: z.string().trim().max(2000).default(""),
});

router.post("/admin/questions/ai/generate", verifyAdminToken, async (req, res) => {
  const parsed = generationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Invalid generation request." });
  const data = parsed.data;
  const hierarchy = await pool.query(
    `SELECT a.name age_group_name,a.min_age,a.max_age,c.name category_name,c.description category_description,
      l.name level_name,l.level_number,l.description level_description
     FROM age_groups a JOIN game_categories c ON c.age_group_id=a.id JOIN game_levels l ON l.category_id=c.id
     WHERE a.id=$1 AND c.id=$2 AND l.id=$3`,
    [data.ageGroupId, data.categoryId, data.levelId],
  );
  const context = hierarchy.rows[0];
  if (!context) return res.status(400).json({ success: false, message: "The selected age group, category, and level do not match." });
  try {
    const generated = await generateQuestionDrafts({
      count: data.count, guidance: data.guidance,
      ageGroupName: context.age_group_name, minAge: Number(context.min_age), maxAge: Number(context.max_age),
      categoryName: context.category_name, categoryDescription: context.category_description || "",
      levelName: context.level_name, levelNumber: Number(context.level_number), levelDescription: context.level_description || "",
    });
    await logActivity({ eventType: "content.questions_ai_generated", title: "AI question drafts generated", description: `${generated.questions.length} drafts generated for ${context.level_name}`, metadata: { levelId: data.levelId, count: generated.questions.length, responseId: generated.responseId } });
    return res.json({ success: true, questions: generated.questions });
  } catch (error: any) {
    return res.status(error.status || 500).json({ success: false, message: error.message || "Questions could not be generated." });
  }
});

router.post("/admin/questions", verifyAdminToken, upload.fields(fields), async (req, res) => {
  const fileMap = (req.files || {}) as Record<string, Express.Multer.File[]>;
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, errors: parsed.error.issues });
  const data = parsed.data;
  const questionFile = fileMap.questionMedia?.[0];
  const questionText = cleanRichText(data.questionText);
  const optionTexts = data.options.map((option) => cleanRichText(option.text));
  if (!plainText(questionText) && !questionFile && !data.shape) return res.status(400).json({ success: false, message: "Question text, media, or a shape is required." });
  if (data.options.filter((option) => option.isCorrect).length !== 1) return res.status(400).json({ success: false, message: "Exactly one option must be correct." });
  if (data.options.some((option, index) => !plainText(optionTexts[index] || "") && !fileMap[`optionMedia${index}`]?.[0] && !option.shape)) return res.status(400).json({ success: false, message: "Every option needs text, media, or a shape." });
  const client = await pool.connect();
  let cloudFiles: Record<string, StoredMedia[]> = {};
  let committed = false;
  try {
    await client.query("BEGIN");
    const hierarchy = await client.query(`SELECT 1 FROM game_levels l JOIN game_categories c ON c.id=l.category_id WHERE l.id=$1 AND c.id=$2 AND c.age_group_id=$3`, [data.levelId, data.categoryId, data.ageGroupId]);
    if (!hierarchy.rowCount) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "The selected age group, category, and level do not match." }); }
    cloudFiles = await storeFiles(fileMap);
    const inserted = await client.query(`INSERT INTO questions(age_group_id,category_id,level_id,question_text,explanation,media_url,media_type,status,shape_type,shape_color) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [data.ageGroupId, data.categoryId, data.levelId, questionText, data.explanation, storedMedia(cloudFiles, "questionMedia")?.url || null, questionFile ? data.questionMediaType : null, data.status, data.shape?.type || null, data.shape?.color || null]);
    for (let index = 0; index < data.options.length; index += 1) {
      const option = data.options[index]!; const file = fileMap[`optionMedia${index}`]?.[0];
      await client.query(`INSERT INTO question_options(question_id,option_order,option_text,media_url,media_type,is_correct,shape_type,shape_color) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [inserted.rows[0].id, index, optionTexts[index], storedMedia(cloudFiles, `optionMedia${index}`)?.url || null, file ? option.mediaType : null, option.isCorrect, option.shape?.type || null, option.shape?.color || null]);
    }
    await client.query("COMMIT");
    committed = true;
    await logActivity({ eventType: "content.question_created", title: "Question created", description: `A ${data.status} question was added` });
    return res.status(201).json({ success: true, question: inserted.rows[0] });
  } catch (error) { if (!committed) { await client.query("ROLLBACK"); await cleanupStored(cloudFiles); } throw error; } finally { client.release(); }
});

router.get("/admin/questions", verifyAdminToken, async (_req, res) => {
  const result = await pool.query(`SELECT q.id,q.question_text,q.status,q.created_at,q.age_group_id,q.category_id,q.level_id,c.name category_name,l.name level_name,l.level_number FROM questions q JOIN game_categories c ON c.id=q.category_id JOIN game_levels l ON l.id=q.level_id ORDER BY q.created_at DESC,q.id DESC`);
  return res.json({ success: true, questions: result.rows.map((row: Record<string, any>) => ({ id: row.id, text: plainText(row.question_text) || "Visual question", status: row.status, createdAt: row.created_at, ageGroupId: row.age_group_id, categoryId: row.category_id, category: row.category_name, levelId: row.level_id, level: row.level_name, levelNumber: row.level_number })) });
});

router.get("/admin/questions/:id", verifyAdminToken, async (req, res) => {
  const result = await pool.query(`SELECT q.*,COALESCE(json_agg(json_build_object('id',o.id,'text',o.option_text,'mediaUrl',o.media_url,'mediaType',o.media_type,'isCorrect',o.is_correct,'shapeType',o.shape_type,'shapeColor',o.shape_color) ORDER BY o.option_order) FILTER (WHERE o.id IS NOT NULL),'[]') options FROM questions q LEFT JOIN question_options o ON o.question_id=q.id WHERE q.id=$1 GROUP BY q.id`, [req.params.id]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ success: false, message: "Question not found." });
  return res.json({ success: true, question: { id: row.id, ageGroupId: row.age_group_id, categoryId: row.category_id, levelId: row.level_id, text: row.question_text, explanation: row.explanation, mediaUrl: row.media_url, mediaType: row.media_type, shapeType: row.shape_type, shapeColor: row.shape_color, status: row.status, options: row.options } });
});

router.put("/admin/questions/:id", verifyAdminToken, upload.fields(fields), async (req, res) => {
  const fileMap = (req.files || {}) as Record<string, Express.Multer.File[]>;
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, errors: parsed.error.issues });
  const data = parsed.data;
  const questionText = cleanRichText(data.questionText);
  const optionTexts = data.options.map((option) => cleanRichText(option.text));
  const removeMedia = new Set(String(req.body.removeMedia || "").split(",").filter(Boolean));
  const client = await pool.connect();
  let cloudFiles: Record<string, StoredMedia[]> = {};
  const replacedUrls: string[] = [];
  let committed = false;
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT q.media_url,q.media_type,COALESCE(json_agg(json_build_object('order',o.option_order,'mediaUrl',o.media_url,'mediaType',o.media_type) ORDER BY o.option_order) FILTER (WHERE o.id IS NOT NULL),'[]') options FROM questions q LEFT JOIN question_options o ON o.question_id=q.id WHERE q.id=$1 GROUP BY q.id`, [req.params.id]);
    if (!current.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Question not found." }); }
    const hierarchy = await client.query(`SELECT 1 FROM game_levels l JOIN game_categories c ON c.id=l.category_id WHERE l.id=$1 AND c.id=$2 AND c.age_group_id=$3`, [data.levelId, data.categoryId, data.ageGroupId]);
    if (!hierarchy.rowCount) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "The selected age group, category, and level do not match." }); }
    cloudFiles = await storeFiles(fileMap);
    const questionFile = fileMap.questionMedia?.[0];
    const questionMediaUrl = questionFile ? storedMedia(cloudFiles, "questionMedia")?.url : removeMedia.has("question") ? null : current.rows[0].media_url;
    if ((questionFile || removeMedia.has("question")) && current.rows[0].media_url) replacedUrls.push(current.rows[0].media_url);
    const questionMediaType = questionFile ? data.questionMediaType : removeMedia.has("question") ? null : current.rows[0].media_type;
    if (!plainText(questionText) && !questionMediaUrl && !data.shape) { await client.query("ROLLBACK"); await cleanupStored(cloudFiles); return res.status(400).json({ success: false, message: "Question text, media, or a shape is required." }); }
    if (data.options.filter((option) => option.isCorrect).length !== 1) { await client.query("ROLLBACK"); await cleanupStored(cloudFiles); return res.status(400).json({ success: false, message: "Exactly one option must be correct." }); }
    await client.query(`UPDATE questions SET age_group_id=$1,category_id=$2,level_id=$3,question_text=$4,explanation=$5,media_url=$6,media_type=$7,status=$8,shape_type=$9,shape_color=$10,updated_at=NOW() WHERE id=$11`, [data.ageGroupId,data.categoryId,data.levelId,questionText,data.explanation,questionMediaUrl,questionMediaType,data.status,data.shape?.type||null,data.shape?.color||null,req.params.id]);
    for (let index = 0; index < 4; index += 1) {
      const option = data.options[index]!; const file = fileMap[`optionMedia${index}`]?.[0]; const existing = current.rows[0].options[index] || {};
      const optionMediaUrl = file ? storedMedia(cloudFiles, `optionMedia${index}`)?.url : removeMedia.has(`option${index}`) ? null : existing.mediaUrl;
      if ((file || removeMedia.has(`option${index}`)) && existing.mediaUrl) replacedUrls.push(existing.mediaUrl);
      const optionMediaType = file ? option.mediaType : removeMedia.has(`option${index}`) ? null : existing.mediaType;
      if (!plainText(optionTexts[index] || "") && !optionMediaUrl && !option.shape) { await client.query("ROLLBACK"); await cleanupStored(cloudFiles); return res.status(400).json({ success: false, message: `Option ${index + 1} needs text, media, or a shape.` }); }
      await client.query(`UPDATE question_options SET option_text=$1,media_url=$2,media_type=$3,is_correct=$4,shape_type=$5,shape_color=$6 WHERE question_id=$7 AND option_order=$8`, [optionTexts[index],optionMediaUrl,optionMediaType,option.isCorrect,option.shape?.type||null,option.shape?.color||null,req.params.id,index]);
    }
    await client.query("COMMIT");
    committed = true;
    await Promise.all(replacedUrls.map(destroyMediaQuietly));
    await logActivity({ eventType: "content.question_updated", title: "Question updated", description: "An existing question was updated" });
    return res.json({ success: true, message: "Question updated." });
  } catch (error) { if (!committed) { await client.query("ROLLBACK"); await cleanupStored(cloudFiles); } throw error; } finally { client.release(); }
});

router.delete("/admin/questions/:id", verifyAdminToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const files = await client.query(`SELECT media_url FROM questions WHERE id=$1 UNION ALL SELECT media_url FROM question_options WHERE question_id=$1`, [req.params.id]);
    const deleted = await client.query("DELETE FROM questions WHERE id=$1 RETURNING id", [req.params.id]);
    if (!deleted.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Question not found." }); }
    await client.query("COMMIT");
    await Promise.all(files.rows.map((fileRow: { media_url: string | null }) => destroyMediaQuietly(fileRow.media_url)));
    await logActivity({ eventType: "content.question_deleted", title: "Question deleted", description: "A question was deleted" });
    return res.json({ success: true, message: "Question deleted." });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

router.get("/admin/levels/:levelId/questions", verifyAdminToken, async (req, res) => {
  const result = await pool.query(`SELECT q.id,q.question_text,q.explanation,q.media_url,q.media_type,q.shape_type,q.shape_color,q.status,q.created_at,l.name level_name,l.level_number,l.points_per_question,l.time_limit_seconds,COALESCE(json_agg(json_build_object('id',o.id,'text',o.option_text,'mediaUrl',o.media_url,'mediaType',o.media_type,'isCorrect',o.is_correct,'shapeType',o.shape_type,'shapeColor',o.shape_color) ORDER BY o.option_order) FILTER (WHERE o.id IS NOT NULL),'[]') options FROM questions q JOIN game_levels l ON l.id=q.level_id LEFT JOIN question_options o ON o.question_id=q.id WHERE q.level_id=$1 GROUP BY q.id,l.name,l.level_number,l.points_per_question,l.time_limit_seconds ORDER BY q.created_at DESC`, [req.params.levelId]);
  const level = await pool.query("SELECT id,name,level_number,description,points_per_question,time_limit_seconds FROM game_levels WHERE id=$1", [req.params.levelId]);
  if (!level.rows[0]) return res.status(404).json({ success: false, message: "Level not found." });
  return res.json({ success: true, level: level.rows[0], questions: result.rows.map((row: Record<string, unknown>) => ({ id: row.id, text: row.question_text, explanation: row.explanation, mediaUrl: row.media_url, mediaType: row.media_type, shapeType: row.shape_type, shapeColor: row.shape_color, status: row.status, createdAt: row.created_at, points: row.points_per_question, timeLimit: row.time_limit_seconds, options: row.options })) });
});

router.get("/catalog/levels/:levelId/questions", async (req, res) => {
  const result = await pool.query(`SELECT q.id,q.question_text,q.explanation,q.media_url,q.media_type,q.shape_type,q.shape_color,l.points_per_question,l.time_limit_seconds,COALESCE(json_agg(json_build_object('id',o.id,'text',o.option_text,'mediaUrl',o.media_url,'mediaType',o.media_type,'isCorrect',o.is_correct,'shapeType',o.shape_type,'shapeColor',o.shape_color) ORDER BY o.option_order) FILTER (WHERE o.id IS NOT NULL),'[]') options FROM questions q JOIN game_levels l ON l.id=q.level_id LEFT JOIN question_options o ON o.question_id=q.id WHERE q.level_id=$1 AND q.status='published' GROUP BY q.id,l.points_per_question,l.time_limit_seconds ORDER BY q.created_at`, [req.params.levelId]);
  res.json({ success: true, questions: result.rows.map((row: Record<string, any>) => ({ id: row.id, text: row.question_text, explanation: row.explanation, mediaUrl: row.media_url, mediaType: row.media_type, shapeType: row.shape_type, shapeColor: row.shape_color, points: row.points_per_question, timeLimit: row.time_limit_seconds, options: row.options.map(({ isCorrect: _hidden, ...option }: Record<string, unknown>) => option) })) });
});

export default router;
