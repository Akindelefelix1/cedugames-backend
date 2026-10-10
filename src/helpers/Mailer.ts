import { env } from "../config/env";

export const SendOtp = async (email: string, otp: string): Promise<void> => {
  if (!env.ZOHO_MAIL_API_TOKEN || !env.ZOHO_MAIL_FROM) {
    throw new Error("ZeptoMail is not configured");
  }

  try {
    // prefix. Keep the environment variable compatible with either format.
    const sendMailToken = env.ZOHO_MAIL_API_TOKEN
      .trim()
      .replace(/^zoho-enczapikey\s+/i, "")
      .replace(/^['"]|['"]$/g, "");

    const response = await fetch(env.ZOHO_MAIL_API_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        Authorization: `zoho-enczapikey ${sendMailToken}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(env.MAIL_SEND_TIMEOUT_MS),
      body: JSON.stringify({
        subject: " Secure One-Time Password (OTP) Verification",

        from: {
          name: env.ZOHO_MAIL_FROM_NAME,
          address: env.ZOHO_MAIL_FROM,
        },
        to: [{ email_address: { address: email, name: email } }],
        htmlbody: `
          <div style="font-family: sans-serif; max-width: 500px; padding: 20px; background-color: #0a0a0a; color: #f5f5f5; border-radius: 12px; border: 1px solid #262626;">
            <h2 style="color: #800080; margin-bottom: 4px;">Cedu</h2>
            <p style="font-size: 14px; color: #a3a3a3;">Use the secure verification pin below to complete your authentication lifecycle initialization:</p>
            <div style="background-color: #171717; padding: 16px; border-radius: 8px; text-align: center; margin: 24px 0; border: 1px solid #404040;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #ffffff;">${otp}</span>
            </div>
            <p style="font-size: 11px; color: #525252; line-height: 1.4;">If you did not initiate this system access validation, please ignore this email sequence. This code expires strictly in 15 minutes.</p>
          </div>
        `,
      }),
    });

    const result = await response.json() as {
      message?: string;
      request_id?: string;
      error?: {
        code?: string;
        message?: string;
        request_id?: string;
        details?: Array<{ code?: string; message?: string; target?: string }>;
      };
    };

    if (!response.ok) {
      throw new Error(
        [
          `ZeptoMail HTTP ${response.status}`,
          result.error?.code,
          result.error?.details?.map((detail) =>
            [detail.code, detail.message, detail.target].filter(Boolean).join(": "),
          ).join(", "),
          result.error?.message || result.message,
          result.error?.request_id && `request ${result.error.request_id}`,
        ].filter(Boolean).join(" - "),
      );
    }

    console.log(JSON.stringify({ level: "info", event: "otp_email_sent", requestId: result.request_id }));
  } catch (error: any) {
    console.error(JSON.stringify({ level: "error", event: "otp_email_failed", message: error.message }));
    throw error;
  }
};
