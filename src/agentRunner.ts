/**
 * Agent runner
 *
 * Shared by alarm-analyze-event-online-agent and alarm-analyze-file-agent.
 * Builds pi-ai Model, creates pi-agent Agent, runs analysis + conversation loop.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import type { AgentModelConfig, Config } from "./config.js";
import { createAgentTools } from "./agentTools.js";
import { loadPromptFile } from "./promptLoader.js";
import { debug } from "./utils/logger.js";
import { createPluginManager, type PluginManager } from "./plugins/index.js";

// Register built-in API providers (openai-completions, etc.)
registerBuiltInApiProviders();

export interface AgentRunnerOptions {
  config: Config;
  initialPrompt: string;
}

/** Build pi-ai Model object from config */
function buildModel(agentModel: AgentModelConfig): Model<"openai-completions"> {
  return {
    id: agentModel.model,
    name: agentModel.model,
    api: (agentModel.api ?? "openai-completions") as "openai-completions",
    provider: "omc-agent",
    baseUrl: agentModel.baseUrl,
    reasoning: agentModel.reasoning ?? false,
    input: agentModel.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: agentModel.contextWindow ?? 128000,
    maxTokens: agentModel.maxTokens ?? 4096,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

/** Handle Agent events, output to terminal in real-time */
function handleAgentEvent(event: any): void {
  switch (event.type) {
    case "message_end": {
      const msg = event.message;
      if (msg.role === "assistant" && msg.content) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            console.log(block.text);
          }
        }
      }
      break;
    }
    case "tool_execution_start": {
      console.log(`\n🔧 Calling tool: ${event.toolName}(${JSON.stringify(event.args)})`);
      break;
    }
    case "tool_execution_end": {
      const result = event.result;
      if (event.isError) {
        let errMsg = "Unknown error";
        if (result?.content) {
          for (const c of result.content) {
            if (c.type === "text" && c.text) errMsg = c.text;
          }
        }
        console.log(`  ❌ Tool execution failed: ${errMsg}`);
      } else {
        if (result?.content) {
          for (const c of result.content) {
            if (c.type === "text" && c.text) {
              const preview = c.text.length > 200 ? c.text.slice(0, 200) + "..." : c.text;
              console.log(`  📋 ${preview}`);
            }
          }
        }
      }
      break;
    }
  }
}

/** Run Agent analysis + conversation loop */
export async function runAgentAnalysis(options: AgentRunnerOptions): Promise<void> {
  const { config, initialPrompt } = options;
  const agentModel = config.agentModel!;

  // 1. Build Model
  const model = buildModel(agentModel);

  // 2. Load agent system prompt
  const systemPrompt = loadPromptFile("agent-sre-deep");

  // 3. Create tools
  const manager = await createPluginManager(config);
  const tools = createAgentTools(config, manager);

  // 4. Tool call counter (reset per answer turn)
  let toolCallCount = 0;

  // 5. Create Agent
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: "off",
      tools,
      messages: [],
    },
    streamFn: streamSimple as any,
    toolExecution: "parallel",
    getApiKey: () => agentModel.token,
    onPayload: (payload: any) => {
      const msgs = payload?.messages;
      if (msgs) {
        debug(`→ LLM request: ${msgs.length} messages`);
        for (const m of msgs) {
          const role = m.role || "?";
          const content = m.content;
          if (Array.isArray(content)) {
            debug(`[${role}] ${content.map((c: any) => c.type === "text" ? c.text : c.type).join(" | ")}`);
          } else {
            debug(`[${role}] ${content}`);
          }
        }
      }
    },
    onResponse: (response: any) => {
      debug(`← LLM response: status=${response.status}`);
    },
    beforeToolCall: async () => {
      toolCallCount++;
      if (toolCallCount > 10) {
        return { block: true, reason: "Maximum tool call count (10) reached for this turn, please summarize analysis conclusions based on available information" };
      }
      return undefined;
    },
  });

  // 6. Subscribe to events, output in real-time
  agent.subscribe((event) => {
    // Reset counter at the start of each answer turn
    if (event.type === "turn_start") {
      toolCallCount = 0;
    }
    handleAgentEvent(event);
  });

  // 7. Send initial prompt
  console.log("\n🤖 Agent starting deep analysis...\n");
  await agent.prompt(initialPrompt);

  // 8. Conversation loop
  console.log("\n💡 Enter a question to continue the conversation, or type exit to quit");
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for await (const line of rl) {
    const input = line.trim();
    if (input === "exit" || input === "quit") {
      rl.close();
      break;
    }
    if (!input) continue;
    console.log("");
    await agent.prompt(input);
  }
}
