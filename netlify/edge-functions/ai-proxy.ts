/**
 * Netlify Edge Function: AI-Optimized Content Proxy
 * 
 * This edge function replicates the functionality of the Cloudflare Worker
 * to intercept requests and inject AI-optimized content for AI-powered visitors.
 * 
 * It detects AI bots (ChatGPT, Claude, Perplexity, etc.) and:
 * 1. Logs the visit to AWS Lambda
 * 2. Fetches optimized content from S3
 * 3. Injects optimized content into original HTML
 * 4. Serves modified content with proper cache headers
 */

import type { Context } from "https://edge.netlify.com";

// Configuration - ORGANIZATION_ID should be set as environment variable
// IMPORTANT: Set ORGANIZATION_ID in Netlify Dashboard → Site settings → Environment variables
// Edge Functions cannot access variables from [build.environment] in netlify.toml
const ORGANIZATION_ID = Deno.env.get("ORGANIZATION_ID") || "";
const ALT_ORIGIN = ORGANIZATION_ID
  ? `https://salespeak-public-serving.s3.amazonaws.com/${ORGANIZATION_ID}`
  : "";
const EXTERNAL_API_URL =
  "https://22i9zfydr3.execute-api.us-west-2.amazonaws.com/prod/event_stream";

// User agent regex patterns for AI bot detection
const CHATGPT_UA_RE = /ChatGPT-User\/1\.0/i;
const GPTBOT_UA_RE = /GPTBot\/1\.0/i;
const GOOGLE_EXTENDED_RE = /Google-Extended/i;
const BING_PREVIEW_RE = /bingpreview/i;
const PERPLEXITY_UA_RE = /PerplexityBot/i;

// Claude-specific user agent patterns
const CLAUDE_USER_RE = /Claude-User/i;
const CLAUDE_WEB_RE = /Claude-Web/i;
const CLAUDE_BOT_RE = /ClaudeBot/i;

// Bypass header to prevent infinite loops when fetching from same origin
const BYPASS_EDGE_FUNCTION_HEADER = "X-Internal-Fetch";

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const ua = request.headers.get("user-agent") || "";
  const qsAgent = url.searchParams.get("user-agent")?.toLowerCase();

  // Skip processing if this is an internal fetch (prevents infinite loop)
  if (request.headers.get(BYPASS_EDGE_FUNCTION_HEADER) === "true") {
    return fetch(request);
  }

  // Validate ORGANIZATION_ID is set
  if (!ORGANIZATION_ID || ORGANIZATION_ID.trim() === "") {
    console.error(
      "ERROR: ORGANIZATION_ID environment variable is not set. " +
      "Please set it in Netlify Dashboard → Site settings → Environment variables"
    );
    // Return original request if ORGANIZATION_ID is missing
    return fetch(request);
  }

  // Handle .txt and .xml files - simple passthrough without AI processing
  if (url.pathname.endsWith(".txt") || url.pathname.endsWith(".xml")) {
    return fetch(request); // normal cache, no AI processing
  }

  // Detect AI visitors
  const isChatGPT = CHATGPT_UA_RE.test(ua) || qsAgent === "chatgpt";
  const isGPTBot = GPTBOT_UA_RE.test(ua);
  const isGoogleExtended = GOOGLE_EXTENDED_RE.test(ua);
  const isBingPreview = BING_PREVIEW_RE.test(ua);
  const isPerplexity = PERPLEXITY_UA_RE.test(ua);
  const isClaudeUser = CLAUDE_USER_RE.test(ua);
  const isClaudeWeb = CLAUDE_WEB_RE.test(ua);
  const isClaudeBot = CLAUDE_BOT_RE.test(ua);

  const isAIVisitor =
    isChatGPT ||
    isGPTBot ||
    isGoogleExtended ||
    isBingPreview ||
    isPerplexity ||
    isClaudeUser ||
    isClaudeWeb ||
    isClaudeBot;

  const currentWebserverOrigin = url.origin;
  const requestId = crypto.randomUUID();
  const clientIp = context.ip || request.headers.get("x-forwarded-for") || "unknown";
  const country = context.geo?.country?.code || "unknown";

  console.log("ORGANIZATION_ID:", ORGANIZATION_ID || "NOT SET");
  console.log("User-Agent:", ua);
  console.log("Current webserver origin:", currentWebserverOrigin);

  // Log AI visits asynchronously (reliable fire-and-forget)
  if (isAIVisitor) {
    const botType = determineBotType(
      isChatGPT,
      isGPTBot,
      isGoogleExtended,
      isBingPreview,
      isPerplexity,
      isClaudeUser,
      isClaudeWeb,
      isClaudeBot
    );

    console.log(botType);

    const postPayload = {
      data: {
        launcher: "proxy",
        url: url.toString(),
        bot_type: botType,
        client_ip: clientIp,
        country: country,
      },
      event_type: "chatgpt_user_agent",
      url: url.toString(),
      user_id: requestId,
      campaign_id: "00000000-0000-0000-0000-000000000000",
      organization_id: ORGANIZATION_ID,
    };

    // Fire-and-forget logging - Netlify continues background fetch after response
    fetch(EXTERNAL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PostmanRuntime/7.32.2",
      },
      body: JSON.stringify(postPayload),
    }).catch((err) => console.error("Failed to POST event:", err));
  }

  /* ─────────── Non-AI visitors: passthrough ─────────── */
  if (!isAIVisitor) {
    console.log("Non-AI → passthrough", url.pathname + url.search);
    return fetch(request); // normal cache
  }

  /* ─────────── AI visitors: inject #optimized-for-ai from ALT into original ─────────── */
  try {
    // Fetch optimized content from ALT origin (S3)
    const altResp = await fetchWithHost(ALT_ORIGIN, url, request, false, true);
    console.log("ALT status", altResp.status, "for", url.pathname + url.search);

    let injectedHTML = "";
    if (altResp.ok) {
      const altText = await altResp.text();
      injectedHTML = extractElementOuterHTMLById(altText, "optimized-for-ai") || "";
    }

    if (!injectedHTML) {
      console.log("No #optimized-for-ai found in ALT; continuing without injection.");
    }

    // Fetch original content from current webserver
    // Use bypass flag to prevent infinite loop when fetching from same origin
    let origResp = await fetchWithHost(
      currentWebserverOrigin,
      url,
      request,
      true,
      false,
      true // bypassEdgeFunction = true to prevent loop
    );

    // Handle redirects (3xx status codes)
    if (origResp.status >= 300 && origResp.status < 400) {
      const loc = origResp.headers.get("location");
      if (loc) {
        console.log("Current webserver redirect →", loc);
        const canonURL = new URL(loc, currentWebserverOrigin);
        const isSameOrigin = canonURL.origin === url.origin;
        origResp = await fetchWithHost(
          canonURL.origin,
          canonURL,
          request,
          true,
          false,
          isSameOrigin // bypass if same origin to prevent loop
        );
      }
    }

    // Inject HTML if we have optimized content and original is HTML
    if (injectedHTML && isHTMLResponse(origResp)) {
      console.log("Injecting AI snippet");
      const originalHTML = await origResp.text();
      const transformedHTML = injectHTML(originalHTML, injectedHTML);

      return finalizeResponse(
        new Response(transformedHTML, {
          status: origResp.status,
          statusText: origResp.statusText,
          headers: origResp.headers,
        }),
        true, // varyUA
        true  // aiVariant
      );
    }

    console.log(
      "AI visitor but no injection/fallback → serving original via fetch(request)"
    );
    return fetch(request);
  } catch (e) {
    console.error("AI path error; falling back to normal fetch:", e);
    return fetch(request);
  }
};

/* ─────────── Helper Functions ─────────── */

/**
 * Determines the bot type from detection flags
 */
function determineBotType(
  isChatGPT: boolean,
  isGPTBot: boolean,
  isGoogleExtended: boolean,
  isBingPreview: boolean,
  isPerplexity: boolean,
  isClaudeUser: boolean,
  isClaudeWeb: boolean,
  isClaudeBot: boolean
): string {
  if (isChatGPT) return "ChatGPT-User";
  if (isGPTBot) return "GPTBot";
  if (isGoogleExtended) return "Google-Extended";
  if (isBingPreview) return "BingPreview";
  if (isPerplexity) return "PerplexityBot";
  if (isClaudeUser) return "Claude-User";
  if (isClaudeWeb) return "Claude-Web";
  if (isClaudeBot) return "ClaudeBot";
  return "Unknown";
}

/**
 * Fetches content from a different origin with optional host header manipulation
 */
async function fetchWithHost(
  origin: string,
  originalURL: URL,
  req: Request,
  fixHost = false,
  logURL = false,
  bypassEdgeFunction = false
): Promise<Response> {
  const proxied = new URL(origin + originalURL.pathname + originalURL.search);
  if (logURL) console.log("Fetching →", proxied.toString());

  const headers = new Headers(req.headers);

  // Add bypass header to prevent infinite loop when fetching from same origin
  if (true || bypassEdgeFunction) {
    headers.set(BYPASS_EDGE_FUNCTION_HEADER, "true");
  }

  if (fixHost) {
    headers.set("host", origin.replace("https://", ""));
  }

  const init: RequestInit = {
    method: req.method,
    headers: headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  };

  return fetch(proxied, init);
}

/**
 * Checks if response is HTML content
 */
function isHTMLResponse(resp: Response): boolean {
  const ct = resp.headers.get("content-type") || "";
  return ct.includes("text/html");
}

/**
 * Extracts an element's outer HTML by ID using regex
 * This matches the Cloudflare Worker implementation
 */
function extractElementOuterHTMLById(html: string, id: string): string {
  const re = new RegExp(
    `<([a-zA-Z0-9:-]+)([^*>]*\\s)?id=(["'])${escapeRegExp(id)}\\3[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`,
    "i"
  );
  const m = html.match(re);
  return m ? m[0] : "";
}

/**
 * Escapes special regex characters
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Injects HTML snippet into the original HTML before </body> tag
 * Note: Cloudflare uses HTMLRewriter for streaming, but Netlify doesn't have that.
 * This uses a simple regex-based approach which works for most cases.
 */
function injectHTML(originalHTML: string, injectedHTML: string): string {
  // Try to inject before </body> tag
  const bodyCloseRegex = /<\/body>/i;
  if (bodyCloseRegex.test(originalHTML)) {
    return originalHTML.replace(bodyCloseRegex, `${injectedHTML}</body>`);
  }

  // Fallback: inject at the end of the HTML
  return originalHTML + injectedHTML;
}

/**
 * Finalizes the response with appropriate headers
 */
function finalizeResponse(
  resp: Response,
  varyUA = false,
  aiVariant = false
): Response {
  const newHeaders = new Headers(resp.headers);
  newHeaders.delete("content-length");

  if (varyUA) {
    const prev = newHeaders.get("Vary");
    newHeaders.set("Vary", prev ? `${prev}, User-Agent` : "User-Agent");
  }

  if (aiVariant) {
    newHeaders.set("Cache-Control", "private, no-store, max-age=0");
    newHeaders.set("Pragma", "no-cache");
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: newHeaders,
  });
}


