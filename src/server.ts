import "dotenv/config";
import { app } from "./app";
import pool from "./config/database_connection";
import { env } from "./config/env";
import { getActivityRetentionDays, purgeExpiredActivityAndNotifications, purgeExpiredInstitutionActivity, purgeExpiredInstitutionLearningHistory, purgeExpiredUploadEvents } from "./helpers/activityLog";

const server = app.listen(env.PORT, () => console.log(JSON.stringify({ level: "info", event: "server_started", port: env.PORT })));
const runRetentionCleanup = async () => {
  const retentionDays = await getActivityRetentionDays();
  await Promise.all([purgeExpiredUploadEvents(), purgeExpiredActivityAndNotifications(retentionDays), purgeExpiredInstitutionActivity(), purgeExpiredInstitutionLearningHistory()]);
};
void runRetentionCleanup();
const auditRetentionTimer = setInterval(() => { void runRetentionCleanup(); }, 24 * 60 * 60 * 1000);
auditRetentionTimer.unref();
const shutdown = (signal: string) => {
  console.log(JSON.stringify({ level: "info", event: "shutdown_started", signal }));
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
