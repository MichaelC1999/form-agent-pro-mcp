import { Router } from "express";

/**
 * Public pages that AI app directories ask for: a privacy policy and
 * documentation, both linking to the support email. Static HTML, no cookies.
 */

export const SUPPORT_EMAIL = "michael@formagent.pro";
export const PRIVACY_PATH = "/privacy";
export const DOCS_PATH = "/docs";

const EFFECTIVE_DATE = "November 22, 2026";

function page(title: string, body: string): string {
  return (
    "<!doctype html><html lang=en><meta charset=utf-8>" +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    `<title>${title} · Form Agent Pro</title>` +
    "<link rel=icon href=/icon.svg type=image/svg+xml>" +
    "<style>body{font-family:system-ui,sans-serif;line-height:1.55;max-width:44rem;margin:3rem auto;" +
    "padding:0 1rem;color:#1a1a1a;background:#fff}h1{font-size:1.8rem}h2{font-size:1.2rem;margin-top:2rem}" +
    "code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}a{color:#0b57d0}" +
    "@media (prefers-color-scheme:dark){body{color:#e8e8e8;background:#141414}code{background:#262626}a{color:#8ab4f8}}</style>" +
    `<body>${body}<hr><p><a href=${DOCS_PATH}>Documentation</a> · <a href=${PRIVACY_PATH}>Privacy</a> · ` +
    `<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p></body></html>`
  );
}

const PRIVACY_HTML = page(
  "Privacy policy",
  `<h1>Privacy policy</h1>
<p>Effective ${EFFECTIVE_DATE}. This policy covers Form Agent Pro (formagent.pro) and its MCP server, which AI apps
such as Claude connect to. Questions or requests: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

<h2>What we collect</h2>
<ul>
<li><b>Account:</b> when you sign in with Google we receive your Google account ID, name and email address.</li>
<li><b>Your case:</b> the description of your situation and the documents your AI app sends us (for example
passports, visas, certificates and prior USCIS notices). These can include sensitive personal information such as
dates of birth, addresses, passport numbers, A-numbers and Social Security numbers.</li>
<li><b>What we produce:</b> the facts extracted from your documents and the filled-in forms.</li>
<li><b>Payments:</b> Stripe handles payment. We receive the payment status and the checkout session ID, never your
card number.</li>
<li><b>Technical data:</b> IP address and request logs, used for security, rate limiting and fixing errors.</li>
</ul>

<h2>How we use it</h2>
<p>Only to prepare your forms, let you download them, take payment, keep the service secure and fix problems.
We do not sell your data, use it for advertising, or share it with anyone except the providers below.</p>

<h2>Who processes it for us</h2>
<ul>
<li><b>Anthropic</b> (Claude API) reads your description and documents to fill in the forms. Under its commercial
terms, Anthropic does not train models on this data.</li>
<li><b>Google</b> handles sign-in.</li>
<li><b>Stripe</b> handles payment.</li>
<li><b>DigitalOcean</b> hosts the server, and a cloud database provider stores your records.</li>
</ul>

<h2>How long we keep it</h2>
<ul>
<li>Uploaded document files are deleted from the server as soon as their text has been read.</li>
<li>Your case, the extracted facts, the filled forms and records of the AI processing are kept so you can come back
and download your forms, until you ask us to delete them.</li>
<li>Sign-in tokens expire (access after 1 hour, refresh after 30 days) and download links after 15 minutes.</li>
</ul>

<h2>Your choices</h2>
<p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> from the address you signed in with to get a copy of
your data or have it deleted. We'll respond within 30 days. You can disconnect Form Agent Pro from your AI app at any
time, which stops new access.</p>

<h2>Security</h2>
<p>Data is sent over HTTPS. Sign-in tokens and download links are stored only as one-way hashes. Each account can
only see its own cases.</p>

<h2>Not legal advice</h2>
<p>Form Agent Pro fills in forms for you to review, sign and file yourself. It is not a law firm, does not give legal
advice and does not submit anything to USCIS or any government.</p>

<h2>Children</h2>
<p>The service is not directed at children under 13, and we don't knowingly collect their data except as part of a
parent's or guardian's case.</p>

<h2>Changes</h2>
<p>We'll update the date above when this policy changes.</p>`
);

const DOCS_HTML = page(
  "Documentation",
  `<h1>Form Agent Pro: documentation</h1>
<p>Form Agent Pro fills in official US immigration forms from your description of your situation and your
supporting documents. It works inside AI apps that support remote MCP servers, such as Claude, ChatGPT and Gemini.</p>

<h2>What it covers</h2>
<ul>
<li><b>Green card / adjustment of status:</b> I-485, I-130, I-130A, I-140, I-864, I-693, plus I-765 (work permit),
I-131 (advance parole) and I-90 (green card replacement).</li>
<li><b>O-1 change of status:</b> I-129 with the O and P supplement, I-539 / I-539A for O-3 family members, I-907.</li>
<li>Some non-US processes, such as the Italian National (Type D) student visa.</li>
</ul>

<h2>Connect</h2>
<p>Add a custom connector (remote MCP server) in your AI app with this URL:</p>
<p><code>https://mcp.formagent.pro/mcp</code></p>
<p>Your app will ask you to sign in with Google. In Claude Code:
<code>claude mcp add --transport http form-agent-pro https://mcp.formagent.pro/mcp</code></p>

<h2>Tools</h2>
<ul>
<li><b>list_supported_forms</b> (free, read-only): which applications and forms can be prepared.</li>
<li><b>build_situation_context</b> (paid): starts a case from your description and documents. The first call returns
a Stripe payment link; once you've paid, ask your AI app to continue and the forms are prepared in a few minutes.</li>
<li><b>get_situation_status</b> (free, read-only): progress, which forms are ready, and any missing information.</li>
<li><b>get_filled_pdf</b> (free): private download links for each form and one merged PDF. Links expire after 15
minutes; ask again for fresh ones.</li>
</ul>

<h2>Example prompts</h2>
<ul>
<li>"I'm married to a US citizen and want to apply for a green card. Can Form Agent Pro prepare my forms?"</li>
<li>"Here are my passport, I-94 and marriage certificate. Prepare my I-485 and I-130."</li>
<li>"How is my case going? Download the forms that are ready."</li>
</ul>

<h2>Pricing</h2>
<p>Checking what's supported, tracking progress and downloading are free. Preparing a case is a one-time payment,
shown on the Stripe checkout page before you pay.</p>

<h2>Important</h2>
<p>Review every form before you sign it. Form Agent Pro is not legal advice and does not file anything for you.
See the <a href=${PRIVACY_PATH}>privacy policy</a> for how your documents are handled.</p>

<h2>Support</h2>
<p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`
);

export const publicPagesRouter = Router();

publicPagesRouter.get(PRIVACY_PATH, (_req, res) => {
  res.type("html").set("Cache-Control", "public, max-age=3600").send(PRIVACY_HTML);
});
publicPagesRouter.get(DOCS_PATH, (_req, res) => {
  res.type("html").set("Cache-Control", "public, max-age=3600").send(DOCS_HTML);
});
