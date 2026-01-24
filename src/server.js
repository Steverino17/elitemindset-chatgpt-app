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

// IMPORTANT: must match your Render public URL (no trailing slash)
const ORIGIN = process.env.PUBLIC_ORIGIN || "https://elitemmindset-chatgpt-app.onrender.com";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Serve images at /images/<file>.png
app.use(
  "/images",
  express.static(path.join(__dirname, "..", "public", "images"), {
    fallthrough: true,
  })
);

// CORS (keep permissive for testing)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, MCP-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------------------- Health ----------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "LOCKDOWN-v2" });
});

// ---------------------- LOCKDOWN OUTPUT ----------------------
function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function stripBad(s) {
  // no bullets / no newlines / no questions / no emojis / no list markers
  return clean(s)
    .replace(/[\u2022\u2023\u25E6\u2043\u2219•●▪︎◦‣⁃]/g, "")
    .replace(/(\r\n|\n|\r)/g, " ")
    .replace(/\?/g, "")
    .replace(/:/g, "")
    .replace(/-/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "") // emoji block
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
  ) return STATE.OVERWHELMED;

  if (
    t.includes("stuck") ||
    t.includes("procrast") ||
    t.includes("avoid") ||
    t.includes("can't start") ||
    t.includes("cant start") ||
    t.includes("scroll") ||
    t.includes("emails") ||
    t.includes("inbox")
  ) return STATE.STUCK;

  if (t.includes("ready") || t.includes("lets do") || t.includes("let's do") || t.includes("start now"))
    return STATE.READY;

  return STATE.UNCLEAR;
}

// One sentence only. No explanations. No options.
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
  const imageUrl = `${ORIGIN}/images/${IMAGES[state]}`;
  const sentence = cap(ACTIONS[state], 140);

  // Screenshot-friendly in Dev Mode: markdown image + one sentence
  const text = `![](${imageUrl}) ${sentence}`;

  // Keep total tight even with URL
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

      // HARD: tool returns only the final output
      return {
        content: [{ type: "text", text: locked }],
      };
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

// ---------------------- Legacy Dev-Mode Fallback: /sse + /messages ----------------------
// Many Dev Mode builds still call these. We hard-return the same locked output.

app.get("/sse", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Tell the client where to POST messages
  res.write(`data: ${JSON.stringify({ type: "endpoint", endpoint: "/messages" })}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(":keepalive\n\n");
  }, 25000);

  req.on("close", () => clearInterval(keepAlive));
});

// Legacy POST used by some clients
app.post("/messages", (req, res) => {
  try {
    const { messages } = req.body || {};
    const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
    const userText = last?.content?.text || "";

    const locked = buildLockedText(userText);

    // IMPORTANT: respond with ONLY the locked text
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
createServer(app).listen(PORT, () => {
  console.log(`EliteMindset server listening on :${PORT}`);
  console.log(`Health: ${ORIGIN}/health`);
  console.log(`Images: ${ORIGIN}/images/<file>.png`);
  console.log(`MCP (primary): POST/GET/DELETE ${ORIGIN}/mcp`);
  console.log(`Legacy (fallback): GET ${ORIGIN}/sse + POST ${ORIGIN}/messages`);
});
