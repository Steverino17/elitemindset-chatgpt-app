#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import http from "http";

const PORT = parseInt(process.env.PORT || "10000");

// Define the four EliteMindset states
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

// Create HTTP server
const httpServer = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.url === "/" || req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // SSE endpoint for MCP - accepts both GET and POST
  if (req.url === "/sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // Send immediate handshake
    res.write(`event: endpoint\ndata: /sse\n\n`);
    
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

    const transport = new SSEServerTransport("/sse", res);
    await server.connect(transport);
    return;
  }

  // 404 for other routes
  res.writeHead(404);
  res.end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`✓ EliteMindset MCP Server running on port ${PORT}`);
  console.log(`✓ Health check: /health`);
  console.log(`✓ SSE endpoint: /sse`);
});
