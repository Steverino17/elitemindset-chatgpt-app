// src/server.js
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;

// IMPORTANT: set this on Render to your service URL (no trailing slash)
// Example for the new service:
// PUBLIC_ORIGIN = https://elitemmindset-chatgpt-app-1.onrender.com
const ORIGIN = (process.env.PUBLIC_ORIGIN || "").trim() || "";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Serve images at /images/<file>.png
app.use(
  "/images",
  express.static(path.join(__dirname, "..", "public", "images"), {
    fallthrough: true,
  })
);

// CORS (permissive for testing)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, MCP-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------------------- ROUTING SAFETY NET ----------------------
// This is the critical fix: Render often checks "/" by default.
// Returning 200 here prevents "no-server" routing failures.
app.get("/", (req, res) => {
  res.status(200).type("text/plain").send("ok");
});

// Health endpoints (support multiple common checks)
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "LOCKDOWN-v2" });
});
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", version: "LOCKDOWN-v2" });
});

// ---------------------- LOCKDOWN OUTPUT ----------------------
function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function stripBad(s) {
  return clean(s)
    .replace(/[\u2022\u2023\u25E6\u2043\u2219•●▪︎◦‣⁃]/g, "")
    .replace(/(\r\n|\n|\r)/g, " ")
    .replace(/\?/g, "")
    .replace(/:/g, "")
    .replace(/-/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .trim();
}

function cap(s, max = 160) {
  const t = stripBad(s);
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

const STATE = {
  OVERWHELMED: "overwhelmed",
  STUCK: "stuck",
  READY: "ready-to-act",
  UNCLEAR: "unclear-direction",
};

function detectState(userText) {
  const t = clean(userText).toLowerCase();

  if (
    t.includes("overwhelm") ||
    t.includes("too much") ||
    t.includes("paralyz") ||
    t.includes("spinning") ||
    t.includes("cant focus") ||
    t.includes("can't focus") ||
    t.includes("losing focus")
  )
    return STATE.OVERWHELMED;

  if (
    t.includes("stuck") ||
    t.includes("procrast") ||
    t.includes("avoid") ||
    t.includes("can't start") ||
    t.includes("cant start") ||
    t.includes("scroll") ||
    t.includes("emails") ||
    t.includes("inbox")
  )
    return STATE.STUCK;

  if (t.includes("ready") || t.includes("lets do") || t.includes("let's do") || t.includes("start now"))
    return STATE.READY;

  return STATE.UNCLEAR;
}

const ACTIONS = {
  [STATE.OVERWHELMED]: "Set a 5 minute timer and do one tiny task that lowers stress immediately.",
  [STATE.STUCK]: "Open the task and do the first 2 minutes only, then stop.",
  [STATE.READY]: "Write your next micro action in 7 words, then do it now.",
  [STATE.UNCLEAR]: "Pick one outcome for the next 15 minutes and ignore everything else.",
};

const IMAGES = {
  [STATE.OVERWHELMED]: "overwhelmed.png",
  [STATE.STUCK]: "stuck.png",
  [STATE.READY]: "ready-to-act.png",
  [STATE.UNCLEAR]: "unclear-direction.png",
};

function buildLockedText(userText) {
  const state = detectState(userText);

  // If PUBLIC_ORIGIN isn't set yet, we still return the sentence (image optional)
  const imageUrl = ORIGIN ? `${ORIGIN}/images/${IMAGES[state]}` : "";
  const sentence = cap(ACTIONS[state], 140);

  if (!imageUrl) return cap(sentence, 260);

  const text = `![](${imageUrl}) ${sentence}`;
  return cap(text, 260);
}

// ---------------------- MCP (Streamable HTTP) ----------------------
function createEliteMindsetServer() {
  const server = new McpServer({
    name: "elitemmindset-mcp",
    version: "1.0.0",
  });

  server.tool(
    "next_best_step",
    "Returns the final user-facing output. Do not add, rephrase, expand, explain, summarize, or append anything.",
    {
      message: z.string().optional(),
      goal: z.string().optional(),
      context: z.string().optional(),
    },
    async ({ message, goal, context }) => {
      const userText = [message, goal, context].filter(Boolean).join(" ");
      const locked = buildLockedText(userText);
      return { content: [{ type: "text", text: locked }] };
    }
  );

  return server;
}

const transports = Object.create(null);

async function ensureTransport(req, res) {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && transports[sessionId]) return transports[sessionId];

  if (!sessionId && isInitializeRequest(req.body)) {
    let transport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
      enableDnsRebindingProtection: false,
    });

    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    const server = createEliteMindsetServer();
    await server.connect(transport);

    return transport;
  }

  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: Missing/invalid MCP session" },
    id: null,
  });

  return null;
}

app.post("/mcp", async (req, res) => {
  try {
    const transport = await ensureTransport(req, res);
    if (!transport) return;
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("/mcp POST error:", err);
    res.status(500).send("Internal error");
  }
});

async function handleMcpSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("Invalid or missing MCP-Session-Id");
  }
  await transports[sessionId].handleRequest(req, res);
}

app.get("/mcp", handleMcpSessionRequest);
app.delete("/mcp", handleMcpSessionRequest);

// ---------------------- Legacy fallback: /sse + /messages ----------------------
app.get("/sse", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(`data: ${JSON.stringify({ type: "endpoint", endpoint: "/messages" })}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(":keepalive\n\n");
  }, 25000);

  req.on("close", () => clearInterval(keepAlive));
});

app.post("/messages", (req, res) => {
  try {
    const { messages } = req.body || {};
    const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
    const userText = last?.content?.text || "";
    const locked = buildLockedText(userText);

    res.json({
      model: "elitemmindset-lockdown-v2",
      content: [{ type: "text", text: locked }],
    });
  } catch (err) {
    console.error("/messages error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------- Start ----------------------
createServer(app).listen(PORT, "0.0.0.0", () => {
  console.log(`EliteMindset server listening on :${PORT}`);
});
