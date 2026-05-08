/**
 * LLM parameter extraction client
 * Calls OpenAI-compatible chat completion API to extract query conditions from alarm events
 *
 * Set environment variable OMC_DEBUG=1 to enable debug logging
 */

import { ExtractorModelConfig } from "./config.js";
import { loadPromptFile } from "./promptLoader.js";
import { debug } from "./utils/logger.js";

/** Structured result extracted by LLM */
export interface ExtractedParams {
  /** Alarm event start time, Unix timestamp (seconds) */
  startTime?: number;
  /** Alarm event end time, Unix timestamp (seconds) */
  endTime?: number;
  appname?: string;
  /** Pod name */
  podname?: string;
  /** API path */
  apiPath?: string;
  /** Downstream service name list, e.g. ["redis", "user-service"] */
  servicer?: string[];
  /** Downstream API path list */
  downstreamApi?: string[];
}

/** Extract time range (Unix seconds) from alarm event JSON, preferring event structure fields, falling back to LLM inference */
function extractTimeFromEvent(event: Record<string, unknown>): { startTime?: number; endTime?: number } {
  // Common time field names (by priority)
  const startFields = ["startsAt", "startTime", "firedAt", "activeAt", "startAt"];
  const endFields = ["endsAt", "endTime", "endAt", "resolvedAt"];

  const parseTime = (val: unknown): number | undefined => {
    if (val == null) return undefined;
    if (typeof val === "number") {
      // Convert millisecond timestamp to seconds
      return val > 1e12 ? Math.floor(val / 1000) : val;
    }
    if (typeof val === "string") {
      const ts = Date.parse(val);
      if (!isNaN(ts)) return Math.floor(ts / 1000);
    }
    return undefined;
  };

  const findField = (obj: Record<string, unknown>, fields: string[]): number | undefined => {
    for (const f of fields) {
      const v = parseTime(obj[f]);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  // First search from top level
  let startTime = findField(event, startFields);
  let endTime = findField(event, endFields);

  // Then search from nested alert/labels/annotations
  for (const key of ["alert", "alerts", "labels", "annotations", "status"]) {
    const nested = event[key];
    if (nested && typeof nested === "object") {
      if (Array.isArray(nested)) {
        // alerts is an array, take the first element
        const first = nested[0];
        if (first && typeof first === "object") {
          if (startTime === undefined) startTime = findField(first as Record<string, unknown>, startFields);
          if (endTime === undefined) endTime = findField(first as Record<string, unknown>, endFields);
        }
      } else {
        if (startTime === undefined) startTime = findField(nested as Record<string, unknown>, startFields);
        if (endTime === undefined) endTime = findField(nested as Record<string, unknown>, endFields);
      }
    }
  }

  return { startTime, endTime };
}

export async function extractParams(
  config: ExtractorModelConfig,
  alertEvent: Record<string, unknown>
): Promise<ExtractedParams> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const userContent = JSON.stringify(alertEvent);

  const requestBody = {
    model: config.model,
    messages: [
      { role: "system", content: loadPromptFile("extract-params") },
      { role: "user", content: userContent },
    ],
    temperature: 0,
  };

  // Debug: print full request parameters
  {
    const requestDebug = {
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.token.slice(0, 4)}****${config.token.slice(-4)}`,
      },
      body: requestBody,
    };
    debug(`[llm] Request params:\n${JSON.stringify(requestDebug, null, 2)}`);
  }

  const startTime = Date.now();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.token}`,
    },
    body: JSON.stringify(requestBody),
  });

  const elapsed = Date.now() - startTime;
  debug(`[llm] Response status: ${response.status}  Elapsed: ${elapsed}ms\n`);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API call failed (${response.status}): ${errorText}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  debug(`[llm] Token usage: ${JSON.stringify(json.usage)}\n`);

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty content");
  }

  debug(`[llm] Response content: ${content}\n`);

  // Extract JSON from LLM response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`LLM response cannot be parsed as JSON: ${content}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as Omit<ExtractedParams, "startTime" | "endTime">;

  // Extract time directly from event JSON (takes priority over LLM inference)
  const eventTime = extractTimeFromEvent(alertEvent);
  if (eventTime.startTime) {
    debug(`[llm] Extracted startTime from event: ${eventTime.startTime} (${new Date(eventTime.startTime * 1000).toISOString()})\n`);
  }
  if (eventTime.endTime) {
    debug(`[llm] Extracted endTime from event: ${eventTime.endTime} (${new Date(eventTime.endTime * 1000).toISOString()})\n`);
  }

  return {
    ...parsed,
    startTime: eventTime.startTime,
    endTime: eventTime.endTime,
  };
}
