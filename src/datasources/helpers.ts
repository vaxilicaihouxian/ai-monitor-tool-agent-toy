/**
 * Datasource common helper functions
 */

import type { ESFieldMapping } from "../config.js";

/**
 * Build extraTerms from Agent tool parameters
 * Map podname/uri to corresponding ES fields based on fieldMapping configuration
 */
export function buildExtraTerms(params: { podname?: string; uri?: string }, fieldMapping?: ESFieldMapping): Record<string, string> {
  const terms: Record<string, string> = {};
  if (params.podname) terms[fieldMapping?.podname || "pod"] = params.podname;
  if (params.uri) terms[fieldMapping?.uri || "uri"] = params.uri;
  return terms;
}
