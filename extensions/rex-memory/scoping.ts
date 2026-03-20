// ============================================================================
// Multi-tenant memory isolation
// ============================================================================

export type MemoryEntry = {
  id: string;
  content: string;
  scope: string;
  agent_id: string | null;
  category: string | null;
  score?: number;
  matchType?: "bm25" | "vector" | "hybrid";
  created_at: string;
  updated_at: string;
};

// Built-in scope hierarchy
const SCOPE_HIERARCHY: Record<string, number> = {
  global: 0, // Everyone can see
  dstudio: 1, // D-Studio team
  kevin: 2, // Kevin only
};

// Kevin's superadmin scope — sees everything
const SUPERADMIN_SCOPE = "*";

// Agent-to-scope assignments (default scoping rules)
const AGENT_SCOPE_MAP: Record<string, string[]> = {
  rex: ["global", "kevin"],
  garry: ["global", "dstudio"],
  milo: ["global", "dstudio"],
  ada: ["global", "dstudio"],
  yoka: ["global", "dstudio"],
};

export function filterByScope(entries: MemoryEntry[], scope: string): MemoryEntry[] {
  // Superadmin sees everything
  if (scope === SUPERADMIN_SCOPE) {
    return entries;
  }

  return entries.filter((entry) => {
    // Global entries are always visible
    if (entry.scope === "global") {
      return true;
    }
    // Exact scope match
    if (entry.scope === scope) {
      return true;
    }
    // Hierarchy: higher scopes can see lower scopes
    const requestedLevel = SCOPE_HIERARCHY[scope];
    const entryLevel = SCOPE_HIERARCHY[entry.scope];
    if (requestedLevel !== undefined && entryLevel !== undefined) {
      return requestedLevel >= entryLevel;
    }
    return false;
  });
}

export function validateScope(agentId: string, requestedScope: string): boolean {
  // Kevin always has access
  if (requestedScope === SUPERADMIN_SCOPE) {
    return agentId === "rex" || agentId === "kevin";
  }

  // Global scope is always valid for reading
  if (requestedScope === "global") {
    return true;
  }

  // Check agent's assigned scopes
  const allowedScopes = AGENT_SCOPE_MAP[agentId];
  if (allowedScopes) {
    return allowedScopes.includes(requestedScope);
  }

  // Unknown agents can only access global
  return requestedScope === "global";
}

export function getAgentScopes(agentId: string): string[] {
  return AGENT_SCOPE_MAP[agentId] ?? ["global"];
}

export function getScopeLevel(scope: string): number {
  return SCOPE_HIERARCHY[scope] ?? -1;
}

export function isValidScope(scope: string): boolean {
  return scope === SUPERADMIN_SCOPE || scope in SCOPE_HIERARCHY || scope.startsWith("client:");
}

export { SUPERADMIN_SCOPE };
