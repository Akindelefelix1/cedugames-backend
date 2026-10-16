import { z } from "zod";

export const InstitutionRegisterSchema = z.object({
  institutionName: z.string().trim().min(2).max(160),
  institutionType: z.string().trim().min(2).max(80),
  ownerName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(7).max(30),
  address: z.string().trim().max(240).optional().or(z.literal("")),
  city: z.string().trim().max(100).optional().or(z.literal("")),
  state: z.string().trim().max(100).optional().or(z.literal("")),
  country: z.string().trim().max(100).default("Nigeria"),
  publicAccess: z.boolean().default(false),
  password: z.string().min(8).max(128),
});

export const InstitutionLoginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(128),
});
