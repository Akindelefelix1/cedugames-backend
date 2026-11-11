import { env } from "../config/env";

export const SendOtp = async (email: string, otp: string, purpose: "register" | "password_reset" = "register"): Promise<void> => {
  if (!env.ZOHO_MAIL_API_TOKEN || !env.ZOHO_MAIL_FROM) {
    throw new Error("ZeptoMail is not configured");
  }

  try {
    // Render values are sometimes pasted with the documented authorization
    // prefix. Keep the environment variable compatible with either format.
    const sendMailToken = env.ZOHO_MAIL_API_TOKEN
      .trim()
      .replace(/^zoho-enczapikey\s+/i, "")
      .replace(/^['"]|['"]$/g, "");

    const response = await fetch(env.ZOHO_MAIL_API_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        Authorization: `Zoho-enczapikey ${sendMailToken}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(env.MAIL_SEND_TIMEOUT_MS),
      body: JSON.stringify({
        subject: purpose === "password_reset" ? "Reset your Cedu password" : "Verify your Cedu account",

        from: {
          name: env.ZOHO_MAIL_FROM_NAME,
          address: env.ZOHO_MAIL_FROM,
        },
        to: [{ email_address: { address: email, name: email } }],
        textbody: `${purpose === "password_reset" ? "Use this code to verify your identity and choose a new password." : "Use this code to verify your email address and finish creating your account."} Your six-digit code is ${otp}. It expires in 15 minutes. If you did not request it, you can ignore this email.`,
        htmlbody: `
          <div style="font-family:Arial,sans-serif;max-width:520px;padding:28px;color:#243047;background:#fff;border:1px solid #e8e5ed;border-radius:14px">
            <h2 style="color:#7442ae;margin:0 0 12px">Cedu</h2>
            <p style="font-size:15px;line-height:1.6">${purpose === "password_reset" ? "Use this code to verify your identity and choose a new password." : "Use this code to verify your email address and finish creating your account."}</p>
            <div style="background:#f7f4fb;padding:18px;text-align:center;margin:22px 0;border-radius:10px">
              <span style="font-size:34px;font-weight:700;letter-spacing:8px;color:#56347f">${otp}</span>
            </div>
            <p style="font-size:13px;color:#647084;line-height:1.5">This six-digit code expires in 15 minutes. If you did not request it, you can ignore this email.</p>
          </div>
        `,
      }),
    });

    const responseText = await response.text();
    let result: {
      message?: string;
      request_id?: string;
      data?: { error_code?: string; message?: string; code?: string };
      error?: {
        code?: string;
        message?: string;
        request_id?: string;
        details?: Array<{ code?: string; message?: string; target?: string }>;
      };
    } = {};
    try { result = JSON.parse(responseText); } catch { /* Preserve the HTTP status when the provider returns a non-JSON error. */ }

    if (!response.ok || result.message?.toLowerCase() === "error" || result.data?.error_code) {
      throw new Error(
        [
          `ZeptoMail HTTP ${response.status}`,
          result.error?.code || result.data?.error_code,
          result.error?.details?.map((detail) =>
            [detail.code, detail.message].filter(Boolean).join(": "),
          ).join(", "),
          result.error?.message || result.data?.message || result.message,
          result.error?.request_id && `request ${result.error.request_id}`,
        ].filter(Boolean).join(" - "),
      );
    }

    console.log(JSON.stringify({ level: "info", event: "otp_email_accepted", requestId: result.request_id || null, providerMessage: result.message || null }));
  } catch (error: any) {
    console.error(JSON.stringify({ level: "error", event: "otp_email_failed", message: error.message }));
    throw error;
  }
};

const escapeEmailHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));

export const SendPlayerNotificationEmail = async (email: string, title: string, message: string): Promise<void> => {
  if (!env.ZOHO_MAIL_API_TOKEN || !env.ZOHO_MAIL_FROM) throw new Error("Email delivery is not configured");
  const sendMailToken = env.ZOHO_MAIL_API_TOKEN.trim().replace(/^zoho-enczapikey\s+/i, "").replace(/^['"]|['"]$/g, "");
  const safeTitle = escapeEmailHtml(title);
  const safeMessage = escapeEmailHtml(message).replace(/\r?\n/g, "<br>");
  const response = await fetch(env.ZOHO_MAIL_API_URL, {
    method: "POST",
    headers: { accept: "application/json", Authorization: `Zoho-enczapikey ${sendMailToken}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(env.MAIL_SEND_TIMEOUT_MS),
    body: JSON.stringify({
      subject: title,
      from: { name: env.ZOHO_MAIL_FROM_NAME, address: env.ZOHO_MAIL_FROM },
      to: [{ email_address: { address: email, name: email } }],
      textbody: `${title}\n\n${message}`,
      htmlbody: `<div style="font-family:Arial,sans-serif;max-width:560px;padding:24px;color:#243047"><h2 style="color:#7442ae">${safeTitle}</h2><p style="font-size:15px;line-height:1.6">${safeMessage}</p><p style="font-size:12px;color:#718096">You received this message from Cedu.</p></div>`,
    }),
  });
  const responseText = await response.text();
  let result: { message?: string; data?: { error_code?: string; message?: string }; error?: { message?: string } } = {};
  try { result = JSON.parse(responseText); } catch { /* Keep the provider status for non-JSON errors. */ }
  if (!response.ok || result.message?.toLowerCase() === "error" || result.data?.error_code) {
    throw new Error(result.error?.message || result.data?.message || result.message || `Notification email failed with HTTP ${response.status}`);
  }
};

export const SendInstitutionInvitation = async (email: string, institutionName: string, inviteLink: string): Promise<void> => {
  if (!env.ZOHO_MAIL_API_TOKEN || !env.ZOHO_MAIL_FROM) throw new Error("Email delivery is not configured");
  const sendMailToken = env.ZOHO_MAIL_API_TOKEN.trim().replace(/^zoho-enczapikey\s+/i, "").replace(/^['"]|['"]$/g, "");
  const response = await fetch(env.ZOHO_MAIL_API_URL, {
    method: "POST",
    headers: { accept: "application/json", Authorization: `zoho-enczapikey ${sendMailToken}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(env.MAIL_SEND_TIMEOUT_MS),
    body: JSON.stringify({
      subject: `${institutionName} invited you to join Cedu`,
      from: { name: env.ZOHO_MAIL_FROM_NAME, address: env.ZOHO_MAIL_FROM },
      to: [{ email_address: { address: email, name: email } }],
      htmlbody: `<div style="font-family:Arial,sans-serif;max-width:560px;padding:24px;color:#142038"><h2 style="color:#7442ae">Join ${institutionName} on Cedu</h2><p>Your institution has invited you to connect with its learning community.</p><p><a href="${inviteLink}" style="display:inline-block;background:#7442ae;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">View invitation</a></p><p style="font-size:12px;color:#718096">If you were not expecting this invitation, you can ignore this email.</p></div>`,
    }),
  });
  const result = await response.json() as { message?: string; request_id?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message || result.message || `Invitation email failed with HTTP ${response.status}`);
  console.log(JSON.stringify({ level: "info", event: "institution_invitation_email_sent", requestId: result.request_id }));
};

export const SendInstitutionStaffInvitation = async (email: string, institutionName: string, role: string, inviteLink: string): Promise<void> => {
  if (!env.ZOHO_MAIL_API_TOKEN || !env.ZOHO_MAIL_FROM) throw new Error("Email delivery is not configured");
  const sendMailToken = env.ZOHO_MAIL_API_TOKEN.trim().replace(/^zoho-enczapikey\s+/i, "").replace(/^['"]|['"]$/g, "");
  const safeName = institutionName.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
  const safeRole = role.replace(/_/g, " ");
  const response = await fetch(env.ZOHO_MAIL_API_URL, {
    method: "POST",
    headers: { accept: "application/json", Authorization: `Zoho-enczapikey ${sendMailToken}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(env.MAIL_SEND_TIMEOUT_MS),
    body: JSON.stringify({
      subject: `Staff invitation from ${institutionName}`,
      from: { name: env.ZOHO_MAIL_FROM_NAME, address: env.ZOHO_MAIL_FROM },
      to: [{ email_address: { address: email, name: email } }],
      htmlbody: `<div style="font-family:Arial,sans-serif;max-width:560px;padding:24px;color:#142038"><h2 style="color:#7442ae">Join ${safeName} on Cedu</h2><p>You have been invited as a <strong>${safeRole}</strong>.</p><p><a href="${inviteLink}" style="display:inline-block;background:#7442ae;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Accept staff invitation</a></p><p style="font-size:12px;color:#718096">This invitation expires in 7 days. Ignore it if you were not expecting it.</p></div>`,
    }),
  });
  const result = await response.json() as { message?: string; request_id?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message || result.message || `Staff invitation email failed with HTTP ${response.status}`);
};
