import { z } from "zod";
import "dotenv/config";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must contain at least 32 characters"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  ZOHO_MAIL_API_URL: z.string().url().default("https://api.zeptomail.com/v1.1/email"),
  ZOHO_MAIL_API_TOKEN: z.string().default(""),
  ZOHO_MAIL_FROM: z.union([z.literal(""), z.string().email()]).default(""),
  ZOHO_MAIL_FROM_NAME: z.string().min(1).default("CeduGames"),
  MAIL_SEND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(10000),
  EMAIL_VERIFICATION_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:5173"),
  SUPER_ADMIN_EMAIL: z.string().email().default("cedugames@gmail.com"),
  SUPER_ADMIN_PASSWORD: z.string().min(10).default("Admin@1234"),
  FLW_SECRET_KEY: z.string().default(""),
  FLW_SECRET_HASH: z.string().default(""),
  FLW_REDIRECT_URL: z.string().url().default("http://localhost:5173/shop"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_QUESTION_MODEL: z.string().min(1).default("gpt-5.6"),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(60000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}
if (parsed.data.NODE_ENV === "production") {
  const missing = [
    !parsed.data.ZOHO_MAIL_API_TOKEN && "ZOHO_MAIL_API_TOKEN",
    !parsed.data.ZOHO_MAIL_FROM && "ZOHO_MAIL_FROM",
    !parsed.data.FLW_SECRET_KEY && "FLW_SECRET_KEY",
    !parsed.data.FLW_SECRET_HASH && "FLW_SECRET_HASH",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
};
