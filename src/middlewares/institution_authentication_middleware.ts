import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import pool from "../config/database_connection";

export interface InstitutionRequest extends Request {
  institution?: { id: string; role: "institution_owner" | "institution_staff"; ver: number; staffId?: string; staffRole?: "teacher" | "content_manager" | "viewer"; staffName?: string; staffEmail?: string };
}

export const verifyInstitutionToken = async (req: InstitutionRequest, res: Response, next: NextFunction): Promise<void> => {
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  if (!token) { res.status(401).json({ success: false, code: "SESSION_INVALID", message: "Missing authorization token." }); return; }
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { issuer: "cedugames-api", audience: "cedugames-institution" }) as { id: string; role: "institution_owner" | "institution_staff"; ver: number; staffId?: string };
    if (decoded.role === "institution_owner") {
      const result = await pool.query("SELECT token_version,is_active FROM institutions WHERE id=$1", [decoded.id]);
      const account = result.rows[0];
      if (!account || !account.is_active || account.token_version !== decoded.ver) throw new Error("Session revoked");
      req.institution = decoded;
    } else if (decoded.role === "institution_staff" && decoded.staffId) {
      const result = await pool.query("SELECT s.id,s.institution_id,s.name,s.email,s.role,s.token_version,i.is_active FROM institution_staff s JOIN institutions i ON i.id=s.institution_id WHERE s.id=$1 AND s.institution_id=$2 AND s.status='active'", [decoded.staffId, decoded.id]);
      const staff = result.rows[0];
      if (!staff || !staff.is_active || staff.token_version !== decoded.ver) throw new Error("Session revoked");
      req.institution = { ...decoded, staffId: staff.id, staffRole: staff.role, staffName: staff.name, staffEmail: staff.email };
      const method = req.method.toUpperCase();
      const path = req.path;
      const allowed = path === "/me" && method === "GET" || decodedStaffPermission(staff.role, method, path);
      if (!allowed) { res.status(403).json({ success: false, code: "INSUFFICIENT_STAFF_ROLE", message: "Your assigned staff role does not allow this action." }); return; }
    } else throw new Error("Invalid institution role");
    next();
  } catch {
    res.status(401).json({ success: false, code: "SESSION_INVALID", message: "Invalid, expired, or revoked institution session token." });
  }
};

const decodedStaffPermission = (role: string, method: string, path: string): boolean => {
  const readOnly = method === "GET" || method === "HEAD";
  const section = path.match(/^\/(dashboard|students|questions|structure|resources|practice-settings|activity|requests)(?:\/|$)/)?.[1];
  if (!section) return false;
  if (role === "viewer") return readOnly && ["dashboard", "students", "activity"].includes(section);
  if (role === "teacher") return readOnly && ["dashboard", "students", "questions", "structure", "resources", "practice-settings", "activity"].includes(section);
  if (role === "content_manager") return ["dashboard", "students", "questions", "structure", "resources", "practice-settings", "activity"].includes(section);
  return false;
};
