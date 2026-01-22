#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createServer } from "http";

const PORT = parseInt(process.env.PORT || "10000");

type CoachingState = "overwhelmed" | "stuck" | "ready_to_act" | "unclear_direction";

// SHORT, ACTIONABLE MESSAGES (Mode 1: Acute Overwhelm)
// Max 90-120 words | ONE instruction set | ZERO explanations
const stateMessages: Record<CoachingState, string> = {
  overwhelmed: `You're not stuck — your brain just has too many open loops.

Do this now:
1. Set a 10-minute timer
2. Write the ONE thing you're avoiding
3. Do the smallest visible action on it for 5 minutes
4. Stop when the timer ends

No deciding. Just motion.

When you're done, come back.`,

  stuck: `Good. You moved.

Now do ONE more small thing:
• A file rename
• A single sentence
• One email

Do it, then reply: DONE

Small wins build momentum.`,

  ready_to_act: `You're building momentum.

What's ONE more small thing you can do in the next 60 seconds?

Do it. Reply when done.

Motion beats perfection.`,

  unclear_direction: `You need clarity, not motivation.

List your top 3 concerns.

I'll help you identify the ONE thing that matters most right now.

Focus first. Action second.`
};

// Image URLs
const stateImages: Record<CoachingState, string> = {
  overwhelmed: "https://i.postimg.cc/2yL0yDkp/overwhelmed.png",
  stuck: "https://i.postimg.cc/wxhJHG1m/stuck.png",
  ready_to_act: "https://i.postimg.cc/3NFMFK7m/ready-to-act.png",
  unclear_direction: "https://i.postimg.cc/xdH5yypN/unclear-direction.png"
};

let interactionCount = 0;

const GetMicroActionSchema = z.object({
  current_state: z.enum(["overwhelmed", "stuck", "ready_to_act", "unclear_direction"]),
  user_context: z.string().optional()
});

function createMCPServer() {
  const server = new Server(
    {
      name: "elitemindset-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "get_micro_action",
          description: "Get personalized micro-action coaching based on your current mental state. Helps users who are overwhelmed, stuck, or unclear on next steps.",
          inputSchema: {
            type: "object",
            properties: {
              current_state: {
                type: "string",
                enum: ["overwhelmed", "stuck", "ready_to_act", "unclear_direction"],
                description: "The user's current mental/emotional state: overwhelmed (too many things), stuck (don't know what to do), ready_to_act (momentum building), unclear_direction (need clarity)"
              },
              user_context: {
                type: "string",
                description: "Optional context about what the user is working on or struggling with"
              }
            },
            required: ["current_state"]
          }
        }
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "get_micro_action") {
      const args = GetMicroActionSchema.parse(request.params.arguments);
      const state = args.current_state as CoachingState;
      
      interactionCount++;
      
      let response = stateMessages[state];
      
      // Add CTA after 3 interactions (gentle, curious)
      if (interactionCount === 3 || interactionCount === 4) {
        response += "\n\n✨ You're building momentum. Want to see what clarity looks like when it's a daily habit?\n→ EliteMindset.ai";
      }
      
      // Add stronger CTA after 5+ interactions (direct, punchy)
      if (interactionCount >= 5) {
        response += "\n\n✨ Motion beats perfection. Clarity beats chaos.\nMake this your daily edge → EliteMindset.ai";
      }
      
      return {
        content: [
          {
            type: "text",
            text: response
          },
          {
            type: "image",
            data: stateImages[state],
            mimeType: "image/png"
          }
        ],
      };
    }
    
    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  return server;
}

const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  // CORS preflight
  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("EliteMindset MCP Server - Clarity in action");
    return;
  }

  // MCP endpoint - handle GET, POST, DELETE
  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createMCPServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal server error");
      }
    }
    return;
  }

  // 404 for other routes
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`✓ EliteMindset MCP Server running on port ${PORT}`);
  console.log(`✓ MCP endpoint: ${MCP_PATH}`);
  console.log(`✓ Mode: Acute Overwhelm (90-120 word responses)`);
  console.log(`✓ Health check: /`);
});
