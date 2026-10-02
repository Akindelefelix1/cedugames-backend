import crypto from "node:crypto";
import pool from "../config/database_connection";
import { env } from "../config/env";
import { recordCoinTransaction } from "./coin_service";

type FlutterwaveTransaction = {
  id: number;
  tx_ref: string;
  status: string;
  amount: number;
  currency: string;
};

const api = "https://api.flutterwave.com/v3";

async function flutterwaveRequest(path: string, init: RequestInit = {}) {
  if (!env.FLW_SECRET_KEY) {
    throw Object.assign(new Error("Payments are not configured."), { status: 503 });
  }
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.FLW_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok || body.status !== "success") {
    console.error("Flutterwave request failed", { path, status: response.status, message: body.message });
    throw Object.assign(new Error("The payment provider could not process this request."), { status: 502 });
  }
  return body;
}

export async function createCoinCheckout(userId: string, packageId: string) {
  const result = await pool.query(
    `SELECT p.id,p.name,p.coins,p.price_minor,p.currency,u.name user_name,u.email
     FROM coin_packages p CROSS JOIN users u
     WHERE p.id=$1 AND p.is_active=true AND u.id=$2`,
    [packageId, userId],
  );
  const selected = result.rows[0];
  if (!selected) throw Object.assign(new Error("Coin package not found."), { status: 404 });
  if (Number(selected.price_minor) <= 0) {
    throw Object.assign(new Error("This package cannot be purchased online."), { status: 409 });
  }

  const txRef = `coin-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO coin_purchase_intents(user_id,package_id,tx_ref,amount_minor,currency,coins)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [userId, selected.id, txRef, selected.price_minor, selected.currency, selected.coins],
  );
  try {
    const payment = await flutterwaveRequest("/payments", {
      method: "POST",
      body: JSON.stringify({
        tx_ref: txRef,
        amount: (Number(selected.price_minor) / 100).toFixed(2),
        currency: selected.currency,
        redirect_url: env.FLW_REDIRECT_URL,
        customer: { email: selected.email, name: selected.user_name },
        meta: { purchase_type: "coin_package", package_id: selected.id },
        customizations: { title: "Cedu Coin Purchase", description: selected.name },
      }),
    });
    return { checkoutUrl: payment.data.link as string, txRef };
  } catch (error) {
    await pool.query("UPDATE coin_purchase_intents SET status='failed',updated_at=NOW() WHERE tx_ref=$1", [txRef]);
    throw error;
  }
}

export async function completeCoinPurchase(transactionId: number, expectedTxRef?: string, expectedUserId?: string) {
  const response = await flutterwaveRequest(`/transactions/${transactionId}/verify`);
  const verified = response.data as FlutterwaveTransaction;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM coin_purchase_intents WHERE tx_ref=$1 FOR UPDATE", [verified.tx_ref]);
    const intent = result.rows[0];
    if (!intent || (expectedTxRef && intent.tx_ref !== expectedTxRef) || (expectedUserId && intent.user_id !== expectedUserId)) {
      throw Object.assign(new Error("Payment does not match this purchase."), { status: 400 });
    }
    if (intent.status === "completed") {
      await client.query("COMMIT");
      return { credited: false, balance: null };
    }
    const paidMinor = Math.round(Number(verified.amount) * 100);
    if (
      verified.status !== "successful" ||
      verified.tx_ref !== intent.tx_ref ||
      verified.currency.toUpperCase() !== intent.currency.trim().toUpperCase() ||
      paidMinor < Number(intent.amount_minor)
    ) {
      throw Object.assign(new Error("Payment has not been successfully verified."), { status: 409 });
    }
    const transaction = await recordCoinTransaction({
      userId: intent.user_id,
      type: "purchase",
      amount: Number(intent.coins),
      packageId: intent.package_id,
      reference: `flutterwave:${verified.id}`,
      description: "Coin package purchase",
      metadata: { txRef: intent.tx_ref, amountMinor: intent.amount_minor, currency: intent.currency.trim() },
    }, client);
    await client.query(
      `UPDATE coin_purchase_intents SET status='completed',flutterwave_transaction_id=$1,completed_at=NOW(),updated_at=NOW()
       WHERE id=$2`,
      [verified.id, intent.id],
    );
    await client.query("COMMIT");
    return { credited: true, balance: Number(transaction.balance_after) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function validFlutterwaveSignature(rawBody: Buffer | undefined, signature: string | undefined) {
  if (!rawBody || !signature || !env.FLW_SECRET_HASH) return false;
  const expected = crypto.createHmac("sha256", env.FLW_SECRET_HASH).update(rawBody).digest("base64");
  const received = Buffer.from(signature);
  const calculated = Buffer.from(expected);
  return received.length === calculated.length && crypto.timingSafeEqual(received, calculated);
}
