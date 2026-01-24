// src/server.js
import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- Static images (repo has /public/images/*) ----
app.use(
  "/images",
  express.static(path.join(__dirname, "..", "public", "images"), {
    fallthrough: true,
  })
);

// ---- Basic CORS (kept permissive for testing) ----
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, MCP-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---- Health check ----
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ---------- Your “state -> response” logic ----------
const stateResponses = {
  overwhelmed: {
    imageFile: "overwhelmed.png",
    message:
      "I can see you're feeling overwhelmed right now.\n\nWhat's the ONE smallest thing you could do in the next 5 minutes that would help?",
  },
  stuck: {
    imageFile: "stuck.png",
    message:
      "You're stuck, and that's normal.\n\nWhat's the main thing preventing action right now?",
  },
  "ready-to-act": {
    imageFile: "ready-to-act.png",
    message:
      "Good. Let's move.\n\nWhat's your next micro-action (something you can do in 2–5 minutes)?",
  },
  "unclear-direction": {
    imageFile: "unclear-direction.png", // make sure this matches the actual filename
    message:
      "You don't need motivation. You need clarity.\n\nWhat question, if answered, would make the next step obvious?",
  },
};

function detectUserState(message) {
  const t = String(message || "").toLowerCase();

  if (t.includes("overwhelmed") || t.includes("too much") || t.includes("can't handle") || t.includes("paralyzed")) {
    return "overwhelmed";
  }
  if (t.includes("stuck") || t.includes("don't know how") || t.includes("not sure how") || t.includes("can't start")) {
    return "stuck";
  }
  if (t.includes("ready") || t.includes("let's do") || t.includes("lets do") || t.includes("start now")) {
    return "ready-to-act";
  }
  if (t.includes("unclear") || t.includes("don't know what") || t.includes("dont know what") || t.includes("which")) {
    return "unclear-direction";
  }

  return "unclear-direction";
}

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// Track “soft CTA after N replies” per session
const sessions = new Map();

function buildStateReply({ state, sessionId, baseUrl }) {
  const session = sessions.get(sessionId) || { count: 0 };
  session.count += 1;
  session.lastState = state;
  sessions.set(sessionId, session);

  const r = stateResponses[state] || stateResponses["unclear-direction"];
  const imageUrl = `${baseUrl}/images/${r.imageFile}`;

  // Markdown image (ChatGPT generally fetches by absolute URL)
  let text = `![${state}](${imageUrl})\n\n${r.message}`;

  // Keep CTA simple + no emojis
  if (session.count >= 3) {
    text += `\n\n---\n\nWant to go deeper? Visit [EliteMindset.ai](https://elitemindset.ai)`;
  }

  return text;
}

// ---------- MCP server factory (one per session) ----------
function createEliteMindsetMcpServer() {
  const server = new McpServer({
    name: "elitemindset-mcp",
    version: "1.0.0",
  });

  server.tool(
    "next_best_step",
    "Use when a user feels stuck, overwhelmed, procrastinating, or unclear. Returns one concrete micro-action and a single follow-up question.",
    {
      message: z.string().optional(),
      goal: z.string().optional(),
      context: z.string().optional(),
      sessionId: z.string().optional(),
      baseUrl: z.string().optional(),
    },
    async ({ message, goal, context, sessionId, baseUrl }) => {
      const combined = [message, goal, context].filter(Boolean).join("\n").trim();
      const state = detectUserState(combined);

      const sid = (sessionId || "default").trim() || "default";
      const url = (baseUrl || "").trim() || "https://elitemindset.ai";

      const text = buildStateReply({ state, sessionId: sid, baseUrl: url });

      return {
        content: [{ type: "text", text }],
      };
    }
  );

  return server;
}

// =======================================================
// 1) LEGACY SSE TRANSPORT (GET /sse + POST /messages)
// =======================================================
const sseSessions = Object.create(null); // sessionId -> { transport, server }

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
    console.error("Error establishing SSE transport:", err);
    try {
      res.status(500).end("Failed to establish SSE transport");
    } catch {}
  }
});

app.post("/messages", async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || "");
    const session = sseSessions[sessionId];

    if (!session) {
      res.status(400).send("No SSE transport found for sessionId");
      return;
    }

    // IMPORTANT: pass req.body explicitly (avoids “stream not readable” issues)
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error("Error handling SSE /messages:", err);
    res.status(500).send("Internal error");
  }
});

// =======================================================
// 2) STREAMABLE HTTP TRANSPORT (POST/GET/DELETE /mcp)
//    This is the modern remote MCP path.
// =======================================================
const httpTransports = Object.create(null); // sessionId -> transport
const httpServers = Object.create(null); // sessionId -> server

async function ensureStreamableTransport(req, res) {
  const sessionIdHeader = req.headers["mcp-session-id"];

  // Existing session
  if (sessionIdHeader && httpTransports[sessionIdHeader]) {
    return httpTransports[sessionIdHeader];
  }

  // New session must start with initialize request
  if (!sessionIdHeader && isInitializeRequest(req.body)) {
    let transport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        httpTransports[sid] = transport;
      },
      // Keep inspector-friendly
      enableDnsRebindingProtection: false,
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete httpTransports[transport.sessionId];
        delete httpServers[transport.sessionId];
      }
    };

    const server = createEliteMindsetMcpServer();
    await server.connect(transport);

    // Store server after sessionId exists
    transport.onsessioninitialized?.((sid) => {
      httpServers[sid] = server;
    });

    return transport;
  }

  // Invalid
  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: Missing/invalid MCP session" },
    id: null,
  });
  return null;
}

app.post("/mcp", async (req, res) => {
  const transport = await ensureStreamableTransport(req, res);
  if (!transport) return;

  // Inject baseUrl + sessionId into tool params automatically when possible
  // (This helps your image URLs be absolute.)
  try {
    const baseUrl = getBaseUrl(req);
    const sessionId = transport.sessionId || (req.headers["mcp-session-id"] || "default");
    const body = req.body;

    // If this is a tools/call request, we can append helpful params
    // without breaking MCP protocol (we only touch params for your own tool).
    if (body?.method === "tools/call" && body?.params?.name === "next_best_step") {
      body.params.arguments = {
        ...(body.params.arguments || {}),
        baseUrl,
        sessionId,
      };
    }

    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("Error handling /mcp POST:", err);
    res.status(500).send("Internal error");
  }
});

async function handleMcpSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !httpTransports[sessionId]) {
    res.status(400).send("Invalid or missing MCP-Session-Id");
    return;
  }
  const transport = httpTransports[sessionId];
  await transport.handleRequest(req, res);
}

app.get("/mcp", handleMcpSessionRequest);
app.delete("/mcp", handleMcpSessionRequest);

// ---- Start server ----
const PORT = process.env.PORT || 10000;
const server = createServer(app);

server.listen(PORT, () => {
  console.log(`EliteMindset MCP server listening on :${PORT}`);
  console.log(`Health: /health`);
  console.log(`Legacy SSE: GET /sse + POST /messages`);
  console.log(`Streamable HTTP: POST/GET/DELETE /mcp`);
});
