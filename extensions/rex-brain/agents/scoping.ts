// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentScope {
  id: string;
  name: string;
  allowedPaths: string[];
  allowedEndpoints: string[];
  memoryScope: string;
}

export interface AccessValidation {
  allowed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Predefined scopes
// ---------------------------------------------------------------------------

const PREDEFINED_SCOPES: Record<string, AgentScope> = {
  kevin: {
    id: "kevin",
    name: "Kevin (full access)",
    allowedPaths: ["*"],
    allowedEndpoints: ["*"],
    memoryScope: "*",
  },
  dstudio: {
    id: "dstudio",
    name: "D-Studio (dstudio projects only)",
    allowedPaths: [
      "~/Documents/Developer/dstudio/**",
      "~/Documents/Developer/keiy/rex/**",
      "~/Documents/Developer/keiy/rex-gateway/**",
    ],
    allowedEndpoints: ["/api/v1/projects/*", "/api/v1/memory/*", "/api/v1/agents/*"],
    memoryScope: "dstudio",
  },
  "client-x": {
    id: "client-x",
    name: "Client X (project-specific)",
    allowedPaths: [],
    allowedEndpoints: ["/api/v1/projects/client-x/*"],
    memoryScope: "client-x",
  },
};

// Runtime scope store (agent ID → scope)
const agentScopes = new Map<string, AgentScope>();

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

function normalizePathPattern(pattern: string): string {
  return pattern.replace(/^~/, process.env.HOME ?? "/home/user");
}

/**
 * Check if a resource path matches a pattern.
 * Supports `*` (match one segment) and `**` (match any depth).
 */
function pathMatchesPattern(resourcePath: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }

  const normalizedPattern = normalizePathPattern(pattern);

  // Exact match
  if (resourcePath === normalizedPattern) {
    return true;
  }

  // ** glob at end: match any sub-path
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return resourcePath === prefix || resourcePath.startsWith(`${prefix}/`);
  }

  // * glob at end: match one segment
  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -2);
    if (!resourcePath.startsWith(`${prefix}/`)) {
      return false;
    }
    const remaining = resourcePath.slice(prefix.length + 1);
    // Must be a single segment (no more slashes)
    return !remaining.includes("/");
  }

  // Simple prefix matching for paths with trailing wildcard in middle
  // (e.g., /api/v1/projects/*/tasks)
  if (normalizedPattern.includes("*")) {
    const parts = normalizedPattern.split("*");
    let pos = 0;
    for (const part of parts) {
      const idx = resourcePath.indexOf(part, pos);
      if (idx === -1) {
        return false;
      }
      pos = idx + part.length;
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a predefined scope by ID.
 */
export function getPredefinedScope(scopeId: string): AgentScope | null {
  return PREDEFINED_SCOPES[scopeId] ?? null;
}

/**
 * List all predefined scope IDs.
 */
export function listPredefinedScopes(): string[] {
  return Object.keys(PREDEFINED_SCOPES);
}

/**
 * Apply a scope to an agent. Stores the scope in memory for runtime checks.
 *
 * @param agentId - The agent to scope
 * @param scope - The scope to apply
 */
export function applyScope(agentId: string, scope: AgentScope): void {
  agentScopes.set(agentId, { ...scope });
}

/**
 * Get the scope currently applied to an agent.
 */
export function getAgentScope(agentId: string): AgentScope | null {
  return agentScopes.get(agentId) ?? null;
}

/**
 * Remove scope from an agent (revoke access).
 */
export function revokeScope(agentId: string): boolean {
  return agentScopes.delete(agentId);
}

/**
 * Validate whether an agent has access to a specific resource.
 *
 * @param agentId - The agent requesting access
 * @param resource - The resource path or endpoint being accessed
 * @returns AccessValidation with allowed status and reason
 */
export function validateAccess(agentId: string, resource: string): AccessValidation {
  const scope = agentScopes.get(agentId);

  if (!scope) {
    return {
      allowed: false,
      reason: `Agent ${agentId} has no scope assigned.`,
    };
  }

  // Check paths first, then endpoints
  const allPatterns = [...scope.allowedPaths, ...scope.allowedEndpoints];

  for (const pattern of allPatterns) {
    if (pathMatchesPattern(resource, pattern)) {
      return {
        allowed: true,
        reason: `Matched pattern: ${pattern}`,
      };
    }
  }

  return {
    allowed: false,
    reason: `Resource ${resource} not allowed by scope ${scope.name}.`,
  };
}

/**
 * Check if a memory query is within an agent's memory scope.
 *
 * @param agentId - The agent making the query
 * @param queryScope - The memory scope being queried
 */
export function validateMemoryAccess(agentId: string, queryScope: string): boolean {
  const scope = agentScopes.get(agentId);
  if (!scope) {
    return false;
  }

  // Wildcard scope = full access
  if (scope.memoryScope === "*") {
    return true;
  }

  // Exact match or prefix match (e.g., scope "dstudio" allows "dstudio/projects")
  return queryScope === scope.memoryScope || queryScope.startsWith(`${scope.memoryScope}/`);
}

/**
 * Create a custom scope for a specific client project.
 */
export function createClientScope(
  clientId: string,
  clientName: string,
  projectPaths: string[],
): AgentScope {
  return {
    id: clientId,
    name: `${clientName} (project-specific)`,
    allowedPaths: projectPaths,
    allowedEndpoints: [`/api/v1/projects/${clientId}/*`],
    memoryScope: clientId,
  };
}
