import { ToolRegistry, type IToolRegistry } from '../../agent/agent-library.ts';

/**
 * Build a tool registry for a subagent by inheriting tools from the parent.
 *
 * Default behaviour (no options): every tool EXCEPT
 *   - visitor-audience tools (`getAudience() === 'visitor'` — rendered screens
 *     and transcript widgets): the parent owns the visitor-facing voice, a
 *     subagent returns data. The declared audience is the marker, NOT the
 *     class hierarchy or `getComponentName()` (process/read tools also set
 *     component names for their observability displays and must stay
 *     inheritable).
 *   - tools whose name is 'Subagent' (prevents recursive nesting; name-based
 *     check is robust to vendored-copy drift between workspaces)
 *
 * Options:
 *   - `excludeNames`: extra tool names to exclude on top of the defaults
 *   - `includeOnlyNames`: whitelist — only tools whose name is in this list
 *     are kept; default exclusions still apply
 *
 * For a fully custom registry (no inheritance), use
 * `new ToolRegistry([new MyTool(), ...])` directly instead of this helper.
 */
export function inheritToolsFromParent(
  parentRegistry: IToolRegistry,
  options?: {
    excludeNames?: string[];
    includeOnlyNames?: string[];
  },
): ToolRegistry {
  const excludeNames = new Set(['Subagent', ...(options?.excludeNames ?? [])]);
  const whitelist = options?.includeOnlyNames ? new Set(options.includeOnlyNames) : null;
  const result = new ToolRegistry();
  for (const tool of parentRegistry.getAllTools()) {
    const name = tool.getName();
    if (excludeNames.has(name)) continue;
    if (tool.getAudience() === 'visitor') continue;
    if (whitelist && !whitelist.has(name)) continue;
    result.registerTool(tool);
  }
  return result;
}
