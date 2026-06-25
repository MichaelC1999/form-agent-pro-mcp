import path from "path";
import nodemailer, { Transporter } from "nodemailer";

/**
 * SMTP-backed transactional email for lead-magnet delivery.
 *
 * Configured for PrivateEmail (Namecheap) hosting on the formagent.pro
 * domain. Defaults match PrivateEmail's published SMTP settings; override
 * via env vars in production.
 */

const SMTP_HOST = process.env.SMTP_HOST ?? "mail.privateemail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT ?? "465", 10);
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASS = process.env.SMTP_PASS ?? "";
const SMTP_FROM_EMAIL =
  process.env.SMTP_FROM_EMAIL ?? SMTP_USER ?? "hello@formagent.pro";
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME ?? "Michael Carroll";
const SMTP_REPLY_TO = process.env.SMTP_REPLY_TO ?? SMTP_FROM_EMAIL;

// Port 465 is implicit-TLS; everything else (587, 2525) is STARTTLS.
const SMTP_SECURE = SMTP_PORT === 465;

let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;
  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error(
      "SMTP credentials missing: set SMTP_USER and SMTP_PASS in the environment"
    );
  }
  cachedTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return cachedTransporter;
}

const CHECKLIST_PDF_PATH = path.resolve(
  process.env.CHECKLIST_PDF_PATH ??
    path.join(__dirname, "..", "..", "assets", "aos-prep-checklist.pdf")
);

const FOUNDER_PLAINTEXT = `Hi,

Thanks for grabbing the checklist. I put this together because filing for a green card is intimidating, and most of what makes it hard isn't legal complexity. It's the dozens of small documents you have to track down before you can even start filling out forms.

The attached PDF is what I wish I had when my wife and I went through this. It lists the documents most marriage-based filers need, in the order USCIS expects them stacked, plus a short guide on how to pay and where to mail your packet.

A few things worth knowing:
  - This is general guidance. Every case has its own quirks. If your situation is complex, talk to an immigration attorney.
  - As of 2026, USCIS only accepts credit/debit card payment (Form G-1450). Don't send checks.
  - Filing fees change. Confirm the current amount on uscis.gov before mailing.

When you're ready to fill out the forms themselves, Form Agent Pro turns plain-English answers into a complete, signature-ready packet, so you don't lose months to a typo or a missed checkbox.

Good luck.

Michael Carroll
Founder, Form Agent Pro
https://formagent.pro
`;

const FOUNDER_HTML = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.55;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
            <tr>
              <td style="background:linear-gradient(135deg,#38bdf8 0%,#818cf8 50%,#c084fc 100%);padding:18px 28px;color:#ffffff;font-weight:700;letter-spacing:0.06em;font-size:13px;">
                FORM AGENT PRO
              </td>
            </tr>
            <tr>
              <td style="padding:28px 28px 8px;">
                <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#0f172a;">Your Green Card Prep Checklist is attached.</h1>
                <p style="margin:0 0 14px;">Hi,</p>
                <p style="margin:0 0 14px;">Thanks for grabbing the checklist. I put this together because filing for a green card is intimidating, and most of what makes it hard isn't legal complexity. It's the dozens of small documents you have to track down before you can even start filling out forms.</p>
                <p style="margin:0 0 14px;">The attached PDF is what I wish I had when my wife and I went through this. It lists the documents most marriage-based filers need, in the order USCIS expects them stacked, plus a short guide on how to pay and where to mail your packet.</p>
                <p style="margin:0 0 8px;"><strong>A few things worth knowing:</strong></p>
                <ul style="margin:0 0 14px;padding-left:20px;">
                  <li style="margin:0 0 6px;">This is general guidance. Every case has its own quirks. If your situation is complex, talk to an immigration attorney.</li>
                  <li style="margin:0 0 6px;">As of 2026, USCIS only accepts credit/debit card payment (Form G-1450). Don't send checks.</li>
                  <li style="margin:0 0 6px;">Filing fees change. Confirm the current amount on uscis.gov before mailing.</li>
                </ul>
                <p style="margin:0 0 14px;">When you're ready to fill out the forms themselves, <strong>Form Agent Pro</strong> turns plain-English answers into a complete, signature-ready packet, so you don't lose months to a typo or a missed checkbox.</p>
                <p style="margin:0 0 22px;">Good luck.</p>
                <p style="margin:0;font-weight:600;color:#0f172a;">Michael Carroll</p>
                <p style="margin:0;color:#6b7280;font-size:13px;">Founder, Form Agent Pro</p>
                <p style="margin:14px 0 0;">
                  <a href="https://formagent.pro" style="color:#4338ca;text-decoration:none;font-weight:600;">formagent.pro &rarr;</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px 28px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.5;">
                Form Agent Pro is not a law firm and does not provide legal advice. You're receiving this because you requested the free checklist on formagent.pro.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

export interface SendChecklistEmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendChecklistEmail(
  toEmail: string
): Promise<SendChecklistEmailResult> {
  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({
      from: { name: SMTP_FROM_NAME, address: SMTP_FROM_EMAIL },
      to: toEmail,
      replyTo: SMTP_REPLY_TO,
      subject: "Your Green Card Prep Checklist",
      text: FOUNDER_PLAINTEXT,
      html: FOUNDER_HTML,
      attachments: [
        {
          filename: "green-card-prep-checklist.pdf",
          path: CHECKLIST_PDF_PATH,
          contentType: "application/pdf",
        },
      ],
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
