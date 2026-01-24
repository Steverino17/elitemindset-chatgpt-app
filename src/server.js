// src/server.js
import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));

// Static images (debug only)
app.use(
  "/images",
  express.static(path.join(__dirname, "..", "public", "images"), {
    fallthrough: true,
  })
);

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, MCP-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Health
app.get("/health", (req, res) => res.json({ status: "ok", version: "EMv2" }));

/* ----------------------------- State + output ----------------------------- */

const STATE = {
  OVERWHELMED: "overwhelmed",
  STUCK: "stuck",
  READY: "ready-to-act",
  UNCLEAR: "unclear-direction",
};

const STATE_CONTENT = {
  [STATE.OVERWHELMED]: {
    imageFile: "overwhelmed.png",
    nextStep: "Set a 5-minute timer and do the smallest task that reduces stress fastest.",
    question: "What is that one small task?",
  },
  [STATE.STUCK]: {
    imageFile: "stuck.png",
    nextStep: "Do a 2-minute version of the task (ridiculously small).",
    question: "What is the 2-minute version?",
  },
  [STATE.READY]: {
    imageFile: "ready-to-act.png",
    nextStep: "Write the next micro-action and do it now.",
    question: "What is your next micro-action?",
  },
  [STATE.UNCLEAR]: {
    imageFile: "unclear-direction.png",
    nextStep: "Choose one outcome for the next 15 minutes and ignore everything else.",
    question: "What outcome matters most right now?",
  },
};

function clean(v) {
  return String(v ?? "").trim();
}

function cap(text, maxChars = 190) {
  const t = clean(text).replace(/\s+/g, " ");
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1) + "…";
}

function detectState(userText) {
  const t = clean(userText).toLowerCase();

  if (
    t.includes("overwhelm") ||
    t.includes("too much") ||
    t.includes("paralyz") ||
    t.includes("spinning") ||
    t.includes("can't handle") ||
    t.includes("cant handle")
  ) return STATE.OVERWHELMED;

  if (
    t.includes("stuck") ||
    t.includes("procrast") ||
    t.includes("avoid") ||
    t.includes("can't start") ||
    t.includes("cant start") ||
    t.includes("scrolling")
  ) return STATE.STUCK;

  if (
    t.includes("ready") ||
    t.includes("lets do") ||
    t.includes("let's do") ||
    t.includes("start now")
  ) return STATE.READY;

  if (
    t.includes("unclear") ||
    t.includes("priorit") ||
    t.includes("don't know what") ||
    t.includes("dont know what") ||
    t.includes("which") ||
    t.includes("decide")
  ) return STATE.UNCLEAR;

  return STATE.UNCLEAR;
}

function loadPngBase64(imageFile) {
  const p = path.join(__dirname, "..", "public", "images", imageFile);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p).toString("base64");
}

// Keep a tiny session counter (optional)
const sessions = new Map();
function bumpSession(sessionId) {
  const s = sessions.get(sessionId) || { count: 0 };
  s.count += 1;
  sessions.set(sessionId, s);
  return s.count;
}

function buildToolContent({ state, sessionId }) {
  const spec = STATE_CONTENT[state] || STATE_CONTENT[STATE.UNCLEAR];
  const base64 = loadPngBase64(spec.imageFile);

  bumpSession(sessionId);

  // HARD FORMAT: exactly 1 next step + 1 question + version marker
  const text = cap(`[EMv2] Next step: ${spec.nextStep}\nQuestion: ${spec.question}`, 210);

  const content = [];

  if (base64) {
    content.push({
      type: "image",
      mimeType: "image/png",
      data: base64,
    });
  } else {
    content.push({
      type: "text",
      text: cap(`[EMv2] Missing image file: ${spec.imageFile}`, 120),
    });
  }

  content.push({ type: "text", text });

  return content;
}

/* ------------------------------- MCP server ------------------------------- */

function createEliteMindsetMcpServer() {
  const server = new McpServer({
    name: "elitemindset-mcp",
    version: "1.0.0",
  });

  server.tool(
    "next_best_step",
    "Use when the user is stuck, overwhelmed, procrastinating, or unclear. Return one next step + one question. Keep it short.",
    {
      message: z.string().optional(),
      goal: z.string().optional(),
      context: z.string().optional(),
      sessionId: z.string().optional(),
    },
    async ({ message, goal, context, sessionId }) => {
      const combined = [message, goal, context].filter(Boolean).join("\n");
      const state = detectState(combined);
      const sid = clean(sessionId) || "default";

      return { content: buildToolContent({ state, sessionId: sid }) };
    }
  );

  return server;
}

/* -------------------------- Legacy SSE (fallback) -------------------------- */

const sseSessions = Object.create(null);

app.get("/sse", async (req, res) => {
  try {
    const transport = new SSEServerTransport("/messages", res);
    const server = createEliteMindsetMcpServer();

    sseSessions[transport.sessionId] = { transport, server };

    res.on("close", () => {
      delete sseSessions[transport.sessionId];
    });

    await server.connect(transport);
  } catch (err) {
    console.error("SSE setup error:", err);
    try {
      res.status(500).end("Failed to establish SSE transport");
    } catch {}
  }
});

app.post("/messages", async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || "");
    const session = sseSessions[sessionId];
    if (!session) return res.status(400).send("No SSE transport for sessionId");
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error("SSE message error:", err);
    res.status(500).send("Internal error");
  }
});

/* -------------------- Streamable HTTP (PRIMARY: /mcp) --------------------- */

const httpTransports = Object.create(null);

async function ensureStreamableTransport(req, res) {
  const sessionIdHeader = req.headers["mcp-session-id"];

  if (sessionIdHeader && httpTransports[sessionIdHeader]) {
    return httpTransports[sessionIdHeader];
  }

  if (!sessionIdHeader && isInitializeRequest(req.body)) {
    let transport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        httpTransports[sid] = transport;
      },
      enableDnsRebindingProtection: false,
    });

    transport.onclose = () => {
      if (transport.sessionId) delete httpTransports[transport.sessionId];
    };

    const server = createEliteMindsetMcpServer();
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
    const transport = await ensureStreamableTransport(req, res);
    if (!transport) return;

    // Ensure stable sessionId injected into tool args
    const body = req.body;
    if (body?.method === "tools/call" && body?.params?.name === "next_best_step") {
      body.params.arguments = {
        ...(body.params.arguments || {}),
        sessionId: transport.sessionId || "default",
      };
    }

    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("/mcp POST error:", err);
    res.status(500).send("Internal error");
  }
});

async function handleMcpSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !httpTransports[sessionId]) {
    return res.status(400).send("Invalid or missing MCP-Session-Id");
  }
  await httpTransports[sessionId].handleRequest(req, res);
}

app.get("/mcp", handleMcpSessionRequest);
app.delete("/mcp", handleMcpSessionRequest);

/* --------------------------------- Start --------------------------------- */

const PORT = process.env.PORT || 10000;
createServer(app).listen(PORT, () => {
  console.log(`EliteMindset MCP server listening on :${PORT}`);
  console.log(`Health: /health`);
  console.log(`Images: /images/<file>.png`);
  console.log(`Streamable HTTP (primary): POST/GET/DELETE /mcp`);
  console.log(`Legacy SSE (fallback): GET /sse + POST /messages`);
});
