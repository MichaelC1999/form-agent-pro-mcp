import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { listProcesses } from "../../lib/processes";
import { checkSpendBudget, checkUserSpendBudget } from "../../lib/spendCap";
import { runWithUsage } from "../../lib/usageContext";
import { deleteTempFiles } from "../../middleware/cleanupUploads";
import { assertSessionPaid, createHostedCheckoutSession } from "../../services/stripe";
import { startSituationBuild } from "../../services/startSituationBuild";
import { logAppError } from "../../models/AppError";
import { publicBaseUrl } from "../oauthProvider";
import { CHECKOUT_COMPLETE_PATH, USER_REVIEW_NOTICE, mcpCaller } from "../shared";
import { isPaymentExempt } from "../../lib/paymentExempt";

const MAX_DOCUMENTS = 20;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
// /mcp bodies go through express.json (10 MB limit); base64 adds ~33%.
const MAX_TOTAL_DOCUMENT_BYTES = 7 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain"] as const;
const EXT_FOR_TYPE: Record<(typeof DOCUMENT_TYPES)[number], string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/plain": ".txt",
};

const outputSchema = {
  status: z
    .enum(["processing", "payment_required", "error"])
    .describe("processing = job started; payment_required = user must pay at checkoutUrl first; error = see message"),
  message: z.string().describe("What happened and what to do next, written for the user"),
  situationalContextId: z.string().optional().describe("ID of the new situation; present when status is processing"),
  checkoutUrl: z.string().optional().describe("Stripe payment page to open in a browser; present when payment is required"),
  stripeSessionId: z.string().optional().describe("Pass this back as stripeSessionId after the user has paid"),
};

type Output = {
  status: "processing" | "payment_required" | "error";
  message: string;
  situationalContextId?: string;
  checkoutUrl?: string;
  stripeSessionId?: string;
};

function result(out: Output): CallToolResult {
  return {
    structuredContent: out,
    content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    isError: out.status === "error",
  };
}

export function registerBuildSituationContext(server: McpServer): void {
  server.registerTool(
    "build_situation_context",
    {
      title: "Prepare a user's filled immigration forms (paid)",
      description:
        "Use when a user wants their immigration application forms filled in, for example a " +
        "marriage-based green card (I-130 + I-485), a work permit (I-765), a travel permit (I-131), " +
        "an affidavit of support (I-864), or an O-1 extraordinary-ability petition with change of " +
        "status (I-129). From the user's description of their situation and their documents, it works " +
        "out which process and forms they need and fills the official PDFs in the background.\n\n" +
        "Which documents to send depends on the case. Family-based: passports, birth and marriage " +
        "certificates, I-94, prior USCIS notices. O-1: the beneficiary's passport, current visa, I-94 " +
        "and I-797 notices, CV, the employer's or agent's offer letter or contract (with company " +
        "details such as FEIN and address), the consultation letter, and an itinerary if there are " +
        "several engagements. For O-1 evidence of acclaim (awards, press, memberships, judging, " +
        "publications, salary), send a written summary of each item in additionalNotes rather than " +
        "the full exhibits, to stay within the upload limits.\n\n" +
        "Costs a one-time payment per case: tell the user and get their agreement before calling. " +
        "One payment covers one call.\n\n" +
        "Payment: call first without stripeSessionId. The result has status 'payment_required' with a " +
        "checkoutUrl — give that link to the user, wait until they say they've paid, then call again " +
        "with the same inputs plus the returned stripeSessionId.\n\n" +
        "On success it returns status 'processing' and a situationalContextId. Building takes several " +
        "minutes. Documents are passed inline as base64 (PDF, JPEG, PNG, WEBP or plain text; up to " +
        `${MAX_DOCUMENTS} files, ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB each, ` +
        `${MAX_TOTAL_DOCUMENT_BYTES / 1024 / 1024} MB total).`,
      inputSchema: {
        situationDescription: z
          .string()
          .min(1)
          .max(20_000)
          .describe(
            "The user's immigration situation in their own words: who they are, current status, family, " +
              "history, and for work petitions their employer or agent, job and achievements"
          ),
        processDescription: z
          .string()
          .min(1)
          .max(5_000)
          .describe(
            "What they want to apply for, e.g. 'green card through marriage to a US citizen' or " +
              "'switch from F-1 to O-1A with my employer as petitioner'"
          ),
        additionalNotes: z.string().max(10_000).optional().describe("Anything else the user wants considered"),
        processIdHint: z
          .string()
          .max(100)
          .optional()
          .describe("Optional processId from list_supported_forms, if the user already knows the process"),
        beneficiaryNames: z
          .array(z.string().min(1).max(200))
          .min(2)
          .max(20)
          .optional()
          .describe("Only for applications covering several beneficiaries: their full names"),
        documents: z
          .array(
            z.object({
              filename: z.string().min(1).max(200).describe("Original file name, e.g. 'passport.pdf'"),
              mimeType: z.enum(DOCUMENT_TYPES),
              contentBase64: z.string().min(1).describe("File contents, base64-encoded"),
            })
          )
          .max(MAX_DOCUMENTS)
          .optional()
          .describe(
            "Supporting documents: passports, visas, I-94s, birth/marriage certificates, prior USCIS " +
              "notices, and for work petitions the CV, offer letter or contract and consultation letter"
          ),
        stripeSessionId: z
          .string()
          .max(200)
          .optional()
          .describe("Leave empty on the first call. After the user pays, pass the stripeSessionId returned earlier"),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        // Starts a paid job: marked destructive so clients confirm with the user before calling.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const caller = mcpCaller(extra.authInfo);
      if (!caller) return result({ status: "error", message: "Not signed in. Reconnect the app and sign in again." });
      const { userId, email } = caller;
      const logTag = `mcp user=${userId}`;

      // ── Validate inputs before anything that costs money or consumes a payment ──
      if (args.processIdHint && !listProcesses().includes(args.processIdHint)) {
        return result({
          status: "error",
          message: `Unknown processIdHint "${args.processIdHint}". Use a processId from list_supported_forms, or leave it out.`,
        });
      }

      const decoded: { filename: string; mimeType: (typeof DOCUMENT_TYPES)[number]; bytes: Buffer }[] = [];
      let totalBytes = 0;
      for (const doc of args.documents ?? []) {
        const b64 = doc.contentBase64.replace(/\s+/g, "");
        if (!BASE64_RE.test(b64)) {
          return result({ status: "error", message: `Document "${doc.filename}" is not valid base64.` });
        }
        const bytes = Buffer.from(b64, "base64");
        if (bytes.length === 0) {
          return result({ status: "error", message: `Document "${doc.filename}" is empty.` });
        }
        if (bytes.length > MAX_DOCUMENT_BYTES) {
          return result({
            status: "error",
            message: `Document "${doc.filename}" is over ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`,
          });
        }
        totalBytes += bytes.length;
        decoded.push({ filename: doc.filename, mimeType: doc.mimeType, bytes });
      }
      if (totalBytes > MAX_TOTAL_DOCUMENT_BYTES) {
        return result({
          status: "error",
          message: `Documents total over ${MAX_TOTAL_DOCUMENT_BYTES / 1024 / 1024} MB. Send fewer or smaller files.`,
        });
      }

      // ── Daily spend caps: whole service, then this user ──
      const budget = await checkSpendBudget(`${logTag} build_situation_context`);
      const userBudget = budget.ok ? await checkUserSpendBudget(userId, `${logTag} build_situation_context`) : budget;
      if (!userBudget.ok && userBudget.reason === "user_cap_reached") {
        return result({
          status: "error",
          message:
            "This account has reached today's usage limit. Please try again tomorrow. No payment was taken.",
        });
      }
      if (!budget.ok || !userBudget.ok) {
        return result({
          status: "error",
          message:
            !budget.ok && budget.reason === "cap_reached"
              ? "The service is at capacity for today. Please try again tomorrow. No payment was taken."
              : "The service is temporarily unavailable. Please try again shortly. No payment was taken.",
        });
      }

      // ── Payment ──
      const newCheckout = async (message: string): Promise<CallToolResult> => {
        try {
          const { sessionId, url } = await createHostedCheckoutSession(
            userId,
            new URL(CHECKOUT_COMPLETE_PATH, publicBaseUrl()).toString()
          );
          return result({ status: "payment_required", message, checkoutUrl: url, stripeSessionId: sessionId });
        } catch (err) {
          console.error(`[mcp] ${logTag} | Failed to create checkout session:`, err);
          logAppError({ err, service: "mcp build_situation_context (checkout)", errorType: "payment", userId });
          return result({ status: "error", message: "Couldn't start checkout. Please try again shortly." });
        }
      };

      // Test mode: allow-listed, Google-verified accounts skip Stripe entirely.
      const exempt = isPaymentExempt(email);
      if (exempt) {
        console.log(`[mcp] ${logTag} | Payment skipped: test-mode account`);
      } else {
        if (!args.stripeSessionId) {
          return newCheckout(
            "Payment is required before preparing forms. Ask the user to pay at checkoutUrl, then call " +
              "build_situation_context again with the same inputs plus this stripeSessionId."
          );
        }
        const paid = await assertSessionPaid(args.stripeSessionId, userId);
        if (!paid.ok) {
          if (paid.status === 402) {
            return result({
              status: "payment_required",
              message:
                "That payment hasn't completed yet. If the user has just paid, wait a moment and call again " +
                "with the same stripeSessionId. Otherwise call again without stripeSessionId for a new payment link.",
              stripeSessionId: args.stripeSessionId,
            });
          }
          // 403: someone else's session. 409: already used for another submission.
          return result({
            status: "error",
            message:
              paid.status === 409
                ? "That payment has already been used for another submission. Call again without stripeSessionId to get a new payment link."
                : "That payment belongs to a different account.",
          });
        }
      }

      // ── Paid: write documents to temp files and start the shared pipeline ──
      // startSituationBuild deletes these files once their text is extracted.
      const uploadedFiles: { path: string; originalname: string; mimetype: string }[] = [];
      try {
        for (const d of decoded) {
          const filePath = path.join(os.tmpdir(), `mcp-doc-${randomUUID()}${EXT_FOR_TYPE[d.mimeType]}`);
          fs.writeFileSync(filePath, d.bytes);
          uploadedFiles.push({ path: filePath, originalname: path.basename(d.filename), mimetype: d.mimeType });
        }

        // Tag every model call in this job (including the background part) as MCP usage.
        const situationalContextId = await runWithUsage({ channel: "mcp", mcpTool: "build_situation_context" }, () => startSituationBuild({
          userId,
          uiAnswers: {
            situationDescription: args.situationDescription,
            processDescription: args.processDescription,
            additionalNotes: args.additionalNotes,
            ...(args.beneficiaryNames
              ? { beneficiaryCount: args.beneficiaryNames.length, beneficiaryNames: args.beneficiaryNames }
              : {}),
          },
          uploadedFiles,
          processIdHint: args.processIdHint,
          requestMeta: { userId, userEmail: email, route: "mcp build_situation_context (background)" },
          logTag,
          serviceLabel: "mcp build_situation_context",
        }));
        console.log(`[mcp] ${logTag} | build_situation_context started id=${situationalContextId}`);

        return result({
          status: "processing",
          message:
            (exempt ? "Test mode: no payment taken. " : "Payment received and the forms are being prepared. ") +
            "This takes several minutes. Keep the " +
            "situationalContextId to check progress and download the forms. " +
            USER_REVIEW_NOTICE,
          situationalContextId,
        });
      } catch (err) {
        // The job never started, so nothing else will delete the files.
        deleteTempFiles(uploadedFiles.map((f) => f.path));
        // The payment was consumed; log loudly so it can be refunded or re-run by hand.
        console.error(`[mcp] ${logTag} | Failed to start pipeline after payment ${args.stripeSessionId}:`, err);
        logAppError({
          err,
          service: "mcp build_situation_context",
          userId,
          metadata: { stripeSessionId: args.stripeSessionId },
        });
        return result({
          status: "error",
          message:
            "Your payment went through, but the job couldn't start. It has been logged for follow-up; " +
            "please contact support with this payment reference: " + args.stripeSessionId,
        });
      }
    }
  );
}
