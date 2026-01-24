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

// Serve images publicly too (nice for debugging)
app.use(
  "/images",
  express.static(path.join(__dirname, "..", "public", "images"), {
    fallthrough: true,
  })
);

// CORS (keep permissive for dev)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, MCP-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Health
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ---------- State + short copy ----------
const stateResponses = {
  overwhelmed: {
    imageFile: "overwhelmed.png",
    text: "Pick one thing. Do 5 minutes.",
    question: "What’s the smallest task that would lower stress fastest?",
  },
  stuck: {
    imageFile: "stuck.png",
    text: "We’re going to make it stupid-easy.",
    question: "What’s the first 2-minute step you can do right now?",
  },
  "ready-to-act": {
    imageFile: "ready-to-act.png",
    text: "Good. Move.",
    question: "What is the next micro-action (2–5 minutes)?",
  },
  "unclear-direction": {
    imageFile: "unclear-direction.png",
    text: "You don’t need motivation. You need a target.",
    question: "What single question, if answered, makes the next step obvious?",
  },
};

function detectUserState(message) {
  const t = String(message || "").toLowerCase();

  if (
    t.includes("overwhelmed") ||
    t.includes("too much") ||
    t.includes("can't handle") ||
    t.includes("paralyzed") ||
    t.includes("spinning")
  )
    return "overwhelmed";

  if (
    t.includes("stuck") ||
    t.includes("can't start") ||
    t.includes("cant start") ||
    t.includes("procrast") ||
    t.includes("avoid")
  )
    return "stuck";

  if (t.includes("ready") || t.includes("let's do") || t.includes("lets do") || t.includes("start now"))
    return "ready-to-act";

  if (
    t.includes("unclear") ||
    t.includes("don't know what") ||
    t.includes("dont know what") ||
    t.includes("prioritize") ||
    t.includes("which")
  )
    return "unclear-direction";

  return "unclear-direction";
}

function loadImageBase64(imageFile) {
  const p = path.join(__dirname, "..", "public", "images", imageFile);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return buf.toString("base64");
}

// Track soft CTA after N tool calls per session
const sessions = new Map();

function buildShortReply({ state, sessionId }) {
  const session = sessions.get(sessionId) || { count: 0 };
  session.count += 1;
  session.lastState = state;
  sessions.set(sessionId, session);

  const r = stateResponses[state] || stateResponses["unclear-direction"];

  // Ultra-short format: 1 line + 1 question
  let text = `${r.text}\n\n${r.question}`;

  // Optional CTA (keep it minimal)
  if (session.count >= 3) {
    text += `\n\n---\nVisit EliteMindset.ai`;
  }

  return text;
}

// ---------- MCP server ----------
function createEliteMindsetMcpServer() {
  const server = new McpServer({
    name: "elitemindset-mcp",
    version: "1.0.0",
  });

  server.tool(
    "next_best_step",
    "Use when the user is stuck, overwhelmed, procrastinating, or unclear. Return one micro-action and one question. Keep it short.",
    {
      message: z.string().optional(),
      goal: z.string().optional(),
      context: z.string().optional(),
      sessionId: z.string().optional(),
    },
    async ({ message, goal, context, sessionId }) => {
      const combined = [message, goal, context].filter(Boolean).join("\n").trim();
      const state = detectUserState(combined);

      const sid = (sessionId || "default").trim() || "default";

      const text = buildShortReply({ state, sessionId: sid });

      // Embed image as MCP image content (reliable rendering)
      const r = stateResponses[state] || stateResponses["unclear-direction"];
      const base64 = loadImageBase64(r.imageFile);

      const content = [];
      if (base64) {
        content.push({
          type: "image",
          mimeType: "image/png",
          data: base64,
        });
      }
      content.push({ type: "text", text });

      return { content };
    }
  );

  return server;
}

// =======================================================
// Legacy SSE: GET /sse + POST /messages
// =======================================================
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

// =======================================================
// Streamable HTTP: POST/GET/DELETE /mcp
// =======================================================
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

    // Ensure your tool gets a stable sessionId for short CTA logic
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
  if (!sessionId || !httpTransports[sessionId]) return res.status(400).send("Invalid or missing MCP-Session-Id");
  await httpTransports[sessionId].handleRequest(req, res);
}

app.get("/mcp", handleMcpSessionRequest);
app.delete("/mcp", handleMcpSessionRequest);

// ---- Start ----
const PORT = process.env.PORT || 10000;
createServer(app).listen(PORT, () => {
  console.log(`EliteMindset MCP server listening on :${PORT}`);
  console.log(`Health: /health`);
  console.log(`Images: /images/<file>.png`);
  console.log(`Legacy SSE: GET /sse + POST /messages`);
  console.log(`Streamable HTTP: POST/GET/DELETE /mcp`);
});
