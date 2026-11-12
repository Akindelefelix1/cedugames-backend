import "dotenv/config";
import pool from "./config/database_connection";
import { dispatchDuePushNotifications } from "./services/push_notification_service";

async function main() {
  try {
    await dispatchDuePushNotifications();
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(JSON.stringify({ level: "error", event: "push_dispatch_job_failed", message: error instanceof Error ? error.message : "unknown" }));
  process.exitCode = 1;
});
