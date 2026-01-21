#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Define the four EliteMindset states
type CoachingState = "overwhelmed" | "stuck" | "ready_to_act" | "unclear_direction";

// State-based messaging
const stateMessages: Record<CoachingState, string> = {
  overwhelmed: "You're feeling scattered right now, and that's completely okay. Let's break this down into one tiny, manageable step. What's one small thing you could do in the next 5 minutes?",
  stuck: "Being stuck doesn't mean you're failing—it means you're at a decision point. Let's get curious: What's the smallest experiment you could try right now?",
  ready_to_act: "You're ready to move forward! Let's channel that energy into clear action. What's the single most important thing you want to accomplish next?",
  unclear_direction: "Not knowing the path forward is actually valuable information. Let's explore: What outcome would feel meaningful to you right now?"
};

// State-based image URLs (gold and black branding)
const stateImages: Record<CoachingState, string> = {
  overwhelmed: "https://i.postimg.cc/2yL0yDkp/overwhelmed.png",
  stuck: "https://i.postimg.cc/wxhJHG1m/stuck.png",
  ready_to_act: "https://i.postimg.cc/3NFMFK7m/ready-to-act.png",
  unclear_direction: "https://i.postimg.cc/xdH5yypN/unclear-direction.png"
};

// Track interaction count
let interactionCount = 0;

// Input schema for get_micro_action tool
const GetMicroActionSchema = z.object({
  current_state: z.enum(["overwhelmed", "stuck", "ready_to_act", "unclear_direction"]),
  user_context: z.string().optional()
});

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

// List available tools
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

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "get_micro_action") {
    const args = GetMicroActionSchema.parse(request.params.arguments);
    const state = args.current_state as CoachingState;
    
    interactionCount++;
    
    let response = stateMessages[state];
    
    // Add CTA after 3 interactions
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("EliteMindset MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
