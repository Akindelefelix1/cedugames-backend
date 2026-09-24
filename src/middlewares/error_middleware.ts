import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";

export const handleGlobalErrors = (err: any, _req: Request, res: Response, _next: NextFunction): void => {
  if (err instanceof SyntaxError && (err as any).status === 400 && "body" in err) {
    res.status(400).json({ success: false, message: "Invalid JSON payload." });
    return;
  }
  if (err?.name === "MulterError" || err?.message === "Unsupported media type." || err?.message?.startsWith("Only JPEG")) {
    res.status(400).json({ success: false, message: err.message || "Invalid uploaded file." });
    return;
  }
  const statusCode = Number(err.status) || 500;
  console.error(JSON.stringify({ level: "error", event: "unhandled_request_error", message: err.message || String(err) }));
  res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 ? "Internal Server Error" : (err.message || "Request failed"),
    ...(env.NODE_ENV === "development" ? { stack: err.stack } : {}),
  });
};
