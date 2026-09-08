import crypto from "node:crypto";
import pool from "../config/database_connection";
import { env } from "../config/env";
import { recordCoinTransaction } from "./coin_service";

const networks = new Set(["MTN", "AIRTEL", "GLO", "9MOBILE"]);

function providerMessage(data: any, fallback: string) {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const collect = (value: any, depth = 0) => {
    if (value === null || value === undefined || depth > 5 || seen.has(value)) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text && text !== "[object Object]") messages.push(text);
      return;
    }
    if (typeof value !== "object") return;
    seen.add(value);
    if (Array.isArray(value)) return value.forEach((item) => collect(item, depth + 1));
    const preferred = ["message", "error", "detail", "description", "msg", "non_field_errors"];
    preferred.forEach((key) => { if (key in value) collect(value[key], depth + 1); });
    Object.entries(value).forEach(([key, child]) => {
      if (!preferred.includes(key) && (Array.isArray(child) || (child && typeof child === "object"))) collect(child, depth + 1);
    });
  };
  collect(data?.message ?? data?.error ?? data?.data?.message ?? data?.data?.error ?? data);
  return [...new Set(messages)].join(", ") || fallback;
}

async function providerPurchase(body: Record<string, unknown>) {
  if (!env.DATA_AND_AIRTIME_API_URL || !env.DATA_AND_AIRTIME_API_KEY) {
    throw Object.assign(new Error("Airtime provider is not configured."), { status: 503 });
  }
  const base = env.DATA_AND_AIRTIME_API_URL.replace(/\/+$/, "");
  const url = /\/api\/v1$/i.test(base) ? `${base}/airtime/buy` : `${base}/api/v1/airtime/buy`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${env.DATA_AND_AIRTIME_API_KEY}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    const providerStatus = `${data?.status ?? data?.data?.status ?? ""}`.toLowerCase();
    const failed = data?.success === false || data?.status === false || ["failed", "failure", "error", "declined"].includes(providerStatus);
    if (!response.ok || failed) throw Object.assign(new Error(providerMessage(data, "The airtime provider declined this purchase.")), { status: 502, providerResponse: data });
    return data;
  } catch (error: any) {
    if (error?.providerResponse || error?.status === 503) throw error;
    if (error?.name === "AbortError") throw Object.assign(new Error("The airtime provider timed out."), { status: 502 });
    throw Object.assign(new Error("The airtime provider is temporarily unavailable."), { status: 502 });
  } finally { clearTimeout(timer); }
}

export async function redeemAirtime(input: { userId: string; phone: string; network: string; amount: number; clientReference: string }) {
  const phone = input.phone.replace(/[\s()-]/g, "");
  const network = input.network.toUpperCase();
  if (!/^(?:\+?234|0)[789]\d{9}$/.test(phone)) throw Object.assign(new Error("Enter a valid Nigerian phone number."), { status: 400 });
  if (!networks.has(network)) throw Object.assign(new Error("Select a supported network."), { status: 400 });
  const amountMinor = Math.round(input.amount * 100);
  const reference = `airtime:${input.userId}:${input.clientReference}`;
  const existing = await pool.query("SELECT * FROM airtime_redemptions WHERE reference=$1", [reference]);
  if (existing.rows[0]) return { redemption: existing.rows[0], repeated: true };

  const client = await pool.connect();
  let redemption: any;
  try {
    await client.query("BEGIN");
    const settingsResult = await client.query("SELECT * FROM airtime_settings WHERE id=1 FOR SHARE");
    const settings = settingsResult.rows[0];
    if (!settings?.is_enabled) throw Object.assign(new Error("Airtime redemption is currently unavailable."), { status: 409 });
    if (amountMinor < Number(settings.minimum_amount_minor) || amountMinor > Number(settings.maximum_amount_minor)) {
      throw Object.assign(new Error(`Airtime must be between NGN ${(Number(settings.minimum_amount_minor) / 100).toLocaleString()} and NGN ${(Number(settings.maximum_amount_minor) / 100).toLocaleString()}.`), { status: 400 });
    }
    const pointsUsed = Math.round(input.amount * Number(settings.points_per_naira));
    const coinTransaction = await recordCoinTransaction({ userId: input.userId, type: "deduction", amount: pointsUsed, description: `${network} airtime for ${phone}`, reference, metadata: { kind: "airtime_redemption", network, phone, amountMinor, currency: "NGN", pointsPerNaira: Number(settings.points_per_naira) } }, client);
    const created = await client.query(`INSERT INTO airtime_redemptions(user_id,coin_transaction_id,phone,network,points_used,points_per_naira,amount_minor,reference)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [input.userId, coinTransaction.id, phone, network, pointsUsed, Number(settings.points_per_naira), amountMinor, reference]);
    redemption = created.rows[0];
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }

  try {
    const provider = await providerPurchase({ network, amount: String(input.amount), phone, reference });
    const providerReference = `${provider?.reference ?? provider?.data?.reference ?? provider?.transactionId ?? provider?.data?.transactionId ?? ""}` || null;
    const completed = await pool.query("UPDATE airtime_redemptions SET status='successful',provider_reference=$1,provider_response=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$3 RETURNING *", [providerReference, provider, redemption.id]);
    return { redemption: completed.rows[0], repeated: false };
  } catch (error: any) {
    const refundClient = await pool.connect();
    try {
      await refundClient.query("BEGIN");
      const locked = await refundClient.query("SELECT * FROM airtime_redemptions WHERE id=$1 FOR UPDATE", [redemption.id]);
      if (locked.rows[0]?.status === "pending") {
        await recordCoinTransaction({ userId: input.userId, type: "adjustment", amount: Number(locked.rows[0].points_used), description: `Refund for failed ${network} airtime purchase`, reference: `${reference}:refund`, metadata: { kind: "airtime_refund", redemptionId: redemption.id, originalReference: reference } }, refundClient);
        await refundClient.query("UPDATE airtime_redemptions SET status='refunded',failure_reason=$1,provider_response=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$3", [String(error.message).slice(0, 500), error.providerResponse || null, redemption.id]);
      }
      await refundClient.query("COMMIT");
    } catch (refundError) { await refundClient.query("ROLLBACK"); console.error("Airtime refund failed", { redemptionId: redemption.id, refundError }); }
    finally { refundClient.release(); }
    throw Object.assign(new Error(`${error.message} Your points have been refunded.`), { status: error.status || 502 });
  }
}
