import "dotenv/config";
import nodemailer from "nodemailer";

/**
 * One-shot SMTP credential check. Tries to authenticate against the
 * configured SMTP server without sending any mail. Prints which config it
 * picked up (with the password masked) and the exact server response on
 * failure.
 *
 *   Local:        npx ts-node src/scripts/verifySmtp.ts
 *   Production:   doctl apps console <app-id> --  npx ts-node src/scripts/verifySmtp.ts
 */

const host = process.env.SMTP_HOST ?? "mail.privateemail.com";
const port = parseInt(process.env.SMTP_PORT ?? "465", 10);
const user = process.env.SMTP_USER ?? "";
const pass = process.env.SMTP_PASS ?? "";
const secure = port === 465;

function mask(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}…${value.slice(-2)} (length ${value.length})`;
}

async function main() {
  console.log("[smtp-verify] config in use:");
  console.log("  host  :", host);
  console.log("  port  :", port);
  console.log("  secure:", secure);
  console.log("  user  :", user || "(empty)");
  console.log("  pass  :", mask(pass));

  if (!user || !pass) {
    console.error(
      "[smtp-verify] SMTP_USER and/or SMTP_PASS are not set. Cannot attempt auth."
    );
    process.exit(2);
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: true, // emit full SMTP conversation to stdout
    debug: true,
  });

  try {
    await transporter.verify();
    console.log("[smtp-verify] OK — credentials accepted by", host);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[smtp-verify] FAILED:", msg);
    process.exit(1);
  }
}

main();
