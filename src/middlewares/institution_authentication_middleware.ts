import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import pool from "../config/database_connection";

export interface InstitutionRequest extends Request {
  institution?: { id: string; role: "institution_owner"; ver: number };
}

export const verifyInstitutionToken = async (req: InstitutionRequest, res: Response, next: NextFunction): Promise<void> => {
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  if (!token) { res.status(401).json({ success: false, code: "SESSION_INVALID", message: "Missing authorization token." }); return; }
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { issuer: "cedugames-api", audience: "cedugames-institution" }) as { id: string; role: "institution_owner"; ver: number };
    const result = await pool.query("SELECT token_version,is_active FROM institutions WHERE id=$1", [decoded.id]);
    const account = result.rows[0];
    if (!account || !account.is_active || decoded.role !== "institution_owner" || account.token_version !== decoded.ver) throw new Error("Session revoked");
    req.institution = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, code: "SESSION_INVALID", message: "Invalid, expired, or revoked institution session token." });
  }
};
