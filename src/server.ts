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

const stateMessages: Record<CoachingState, string> = {
  overwhelmed: "You're feeling scattered right now, and that's completely okay. Let's break this down into one tiny, manageable step. What's one small thing you could do in the next 5 minutes?",
  stuck: "Being stuck doesn't mean you're failing—it means you're at a decision point. Let's get curious: What's the smallest experiment you could try right now?",
  ready_to_act: "You're ready to move forward! Let's channel that energy into clear action. What's the single most important thing you want to accomplish next?",
  unclear_direction: "Not knowing the path forward is actually valuable information. Let's explore: What outcome would feel meaningful to you right now?"
};

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
          description: "Get personalized micro-action coaching based on your current mental state",
          inputSchema: {
            type: "object",
            properties: {
              current_state: {
                type: "string",
                enum: ["overwhelmed", "stuck", "ready_to_act", "unclear_direction"],
                description: "Your current mental/emotional state"
              },
              user_context: {
                type: "string",
                description: "Optional context about what you're working on"
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
      
      if (interactionCount >= 3) {
        response += "\n\n✨ Ready for deeper transformation? Visit EliteMindset.ai for personalized coaching programs.";
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
    res.end("EliteMindset MCP Server");
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
  console.log(`✓ Health check: /`);
});
