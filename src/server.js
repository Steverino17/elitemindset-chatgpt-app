// src/server.js
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;

// IMPORTANT: Set this to your Render origin (no trailing slash)
const ORIGIN = process.env.PUBLIC_ORIGIN || "https://elitemindset-chatgpt-app.onrender.com";

// ---------------------------- Express basics ----------------------------

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use(
  "/images",
  express.static(path.join(__dirname, "..", "public", "images"), {
    fallthrough: true,
  })
);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, MCP-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "LOCKDOWN-v1" });
});

// ---------------------------- Output lockdown ----------------------------

function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function removeBadStuff(s) {
  // Remove list-like and “coachy” formatting triggers
  return clean(s)
    .replace(/[\u2022\u2023\u25E6\u2043\u2219•●▪︎◦‣⁃]/g, "") // bullets
    .replace(/(\r\n|\n|\r)/g, " ") // no newlines
    .replace(/\?/g, "") // no questions
    .replace(/:/g, "") // avoids "Step:" patterns
    .replace(/-/g, " ") // avoids list vibes
    .replace(/\s{2,}/g, " ")
    .trim();
}

function hardCap(s, max = 160) {
  const t = removeBadStuff(s);
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

// ---------------------------- State detection ----------------------------

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
  ) {
    return STATE.OVERWHELMED;
  }

  if (
    t.includes("stuck") ||
    t.includes("procrast") ||
    t.includes("avoid") ||
    t.includes("can't start") ||
    t.includes("cant start") ||
    t.includes("scroll")
  ) {
    return STATE.STUCK;
  }

  if (t.includes("ready") || t.includes("let's do") || t.includes("lets do") || t.includes("start now")) {
    return STATE.READY;
  }

  return STATE.UNCLEAR;
}

// ---------------------------- One-sentence actions ----------------------------
// Each action is intentionally ONE sentence, no lists, no explanations.
const ACTIONS = {
  [STATE.OVERWHELMED]:
    "Set a 5 minute timer and do the smallest task that lowers your stress right now.",
  [STATE.STUCK]:
    "Open the task and do a 2 minute version of it with zero pressure to finish.",
  [STATE.READY]:
    "Write your next micro action in 7 words or less and do it immediately.",
  [STATE.UNCLEAR]:
    "Choose one outcome for the next 15 minutes and ignore everything else.",
};

const IMAGES = {
  [STATE.OVERWHELMED]: "overwhelmed.png",
  [STATE.STUCK]: "stuck.png",
  [STATE.READY]: "ready-to-act.png",
  [STATE.UNCLEAR]: "unclear-direction.png",
};

function buildLockedResponse(userText) {
  const state = detectState(userText);
  const imageUrl = `${ORIGIN}/images/${IMAGES[state]}`;

  // Dev Mode screenshot-friendly: markdown image + ONE locked sentence.
  // The sentence is hard-capped and stripped of bullets/questions/newlines.
  const sentence = hardCap(ACTIONS[state], 160);

  // EXACT format: image then sentence (no bullets, no extras)
  const text = `![](${imageUrl}) ${sentence}`;

  return hardCap(text, 260); // keeps total tight even with URL
}

// ---------------------------- MCP server ----------------------------

function createEliteMindsetServer() {
  const server = new McpServer({
    name: "elitemindset-mcp",
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
      const locked = buildLockedResponse(userText);

      return {
        content: [
          {
            type: "text",
            text: locked,
          },
        ],
      };
    }
  );

  return server;
}

// ---------------------------- Streamable HTTP (/mcp) ----------------------------

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

// ---------------------------- Start ----------------------------

createServer(app).listen(PORT, () => {
  console.log(`EliteMindset MCP server listening on :${PORT}`);
  console.log(`Health: ${ORIGIN}/health`);
  console.log(`Images: ${ORIGIN}/images/<file>.png`);
  console.log(`MCP: ${ORIGIN}/mcp`);
});
