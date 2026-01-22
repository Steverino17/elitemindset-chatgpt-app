import express from 'express';
import { createServer } from 'http';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static files from root directory
app.use(express.static(path.join(__dirname, '..')));

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'healthy' });
});

// SSE endpoint for MCP
app.get('/sse', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ type: 'endpoint', endpoint: '/message' });

  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

// Types
type UserState = 'overwhelmed' | 'stuck' | 'ready-to-act' | 'unclear-direction';

interface StateResponse {
  [key: string]: {
    imagePath: string;
    message: string;
  };
}

interface UserSession {
  responseCount: number;
  lastState?: UserState;
}

const sessions = new Map<string, UserSession>();

// State responses - images in ROOT folder
const stateResponses: StateResponse = {
  overwhelmed: {
    imagePath: '/overwhelmed.png',
    message: "I can see you're feeling overwhelmed right now. Let's break this down together.\n\n" +
             "What's the ONE smallest thing you could do in the next 5 minutes that would help?"
  },
  stuck: {
    imagePath: '/stuck.png',
    message: "You're stuck, and that's completely normal. Let's get you unstuck.\n\n" +
             "What's preventing you from taking action right now?"
  },
  'ready-to-act': {
    imagePath: '/ready-to-act.png',
    message: "Great! You're ready to move forward. Let's make this happen.\n\n" +
             "What's your very next micro-action?"
  },
  'unclear-direction': {
    imagePath: '/Unclear-direction.png',
    message: "It sounds like you need clarity before taking action.\n\n" +
             "What specific question, if answered, would help you move forward?"
  }
};

function detectUserState(message: string): UserState {
  const lowerMessage = message.toLowerCase();
  
  if (lowerMessage.includes('overwhelmed') || lowerMessage.includes('too much') || lowerMessage.includes('can\'t handle')) {
    return 'overwhelmed';
  }
  if (lowerMessage.includes('stuck') || lowerMessage.includes('don\'t know how') || lowerMessage.includes('not sure how')) {
    return 'stuck';
  }
  if (lowerMessage.includes('ready') || lowerMessage.includes('let\'s do') || lowerMessage.includes('start')) {
    return 'ready-to-act';
  }
  if (lowerMessage.includes('unclear') || lowerMessage.includes('don\'t know what') || lowerMessage.includes('which')) {
    return 'unclear-direction';
  }
  
  return 'unclear-direction';
}

function getStateResponse(state: UserState, sessionId: string): string {
  let session = sessions.get(sessionId);
  
  if (!session) {
    session = { responseCount: 0 };
    sessions.set(sessionId, session);
  }
  
  session.responseCount++;
  session.lastState = state;
  
  const response = stateResponses[state];
  let fullResponse = `![${state}](${response.imagePath})\n\n${response.message}`;
  
  if (session.responseCount >= 3) {
    fullResponse += "\n\n---\n\n🎯 **Ready for deeper transformation?**\n\n" +
                   "Visit [EliteMindset.ai](https://elitemindset.ai) for personalized coaching and tools.";
  }
  
  return fullResponse;
}

// Message endpoint
app.post('/message', (req: Request, res: Response) => {
  try {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request format' });
    }

    const lastMessage = messages[messages.length - 1];
    const userMessage = lastMessage?.content?.text || '';
    const sessionId = req.headers['x-session-id'] as string || 'default';
    
    const detectedState = detectUserState(userMessage);
    const responseText = getStateResponse(detectedState, sessionId);
    
    res.json({
      model: 'elitemindset-v1',
      content: [{
        type: 'text',
        text: responseText
      }]
    });
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const server = createServer(app);

server.listen(PORT, () => {
  console.log(`EliteMindset MCP Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
