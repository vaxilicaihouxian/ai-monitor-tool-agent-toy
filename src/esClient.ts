/**
 * ES HTTP client with Basic Auth support
 */

import { debug } from "./utils/logger.js";

export interface ESClientConfig {
  host: string;
  username?: string;
  password?: string;
}

export interface ESQueryBody {
  query: Record<string, unknown>;
  size: number;
  sort: Array<Record<string, { order: "asc" | "desc"; unmapped_type?: "date" | "string" | "long" | "integer" }>>;
}

export interface ESSearchResult {
  hits: {
    total?: { value: number };
    hits: Array<{ _source: Record<string, unknown>; _id: string; [key: string]: unknown }>;
  };
}

export async function esSearch(
  clientConfig: ESClientConfig,
  indexPattern: string,
  queryBody: ESQueryBody
): Promise<ESSearchResult> {
  const url = `${clientConfig.host}/${indexPattern}/_search`;

  debug(`[ES] POST ${url}`);
  debug(`[ES] query: ${JSON.stringify(queryBody, null, 2)}`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (clientConfig.username && clientConfig.password) {
    const auth = Buffer.from(
      `${clientConfig.username}:${clientConfig.password}`
    ).toString("base64");
    headers["Authorization"] = `Basic ${auth}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(queryBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ES query failed (${response.status}): ${errorText}`);
  }

  const json = (await response.json()) as ESSearchResult & {
    error?: { reason?: string };
  };

  if (json.error) {
    throw new Error(
      `ES query error: ${json.error.reason || JSON.stringify(json.error)}`
    );
  }

  return json;
}
