import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import crypto from "node:crypto";
import path from "node:path";
import routes from "./routes/index";
import pool from "./config/database_connection";
import { env } from "./config/env";
import { handleGlobalErrors } from "./middlewares/error_middleware";

export const app = express();
app.disable("x-powered-by");
if (env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use((req, res, next) => {
  const requestId = req.header("x-request-id") || crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  const started = Date.now();
  res.on("finish", () => console.log(JSON.stringify({ level: "info", event: "request", requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started })));
  next();
});
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json({
  limit: "100kb",
  verify: (req, _res, buffer) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  },
}));
// Keep legacy local media readable while all new uploads are stored in Cloudinary.
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads"), { fallthrough: false, maxAge: "7d" }));
app.use(rateLimit({ windowMs: 15 * 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }));
app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
app.get("/health/ready", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ status: "ready" }); }
  catch { res.status(503).json({ status: "not_ready" }); }
});
app.use(routes);
app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found." }));
app.use(handleGlobalErrors);
