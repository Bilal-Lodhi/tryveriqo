/**
 * Shared dependency container for API routes.
 *
 * Routes receive their collaborators explicitly instead of importing module
 * singletons. That keeps the AI provider substitutable at one boundary and
 * lets automated tests drive the whole HTTP surface with stub collaborators.
 */

import type { AppConfig } from "../config.js";
import type { AssessmentAiClient } from "../agents/gemini-client.js";
import type { McpClient } from "../mcp-client.js";
import type { SessionRegistry } from "../integrity-session.js";

export interface ApiDependencies {
  config: AppConfig;
  ai: AssessmentAiClient;
  mcp: McpClient;
  sessions: SessionRegistry;
  /** Sink for operational diagnostics; never receives secret material. */
  log: (message: string) => void;
}
