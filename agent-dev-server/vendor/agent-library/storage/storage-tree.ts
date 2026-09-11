import type { AgentStorage } from './agent-storage.ts';

/** List one branch's files as branch-relative paths (strips a leading `${branch}/`). */
export async function listBranchRelativePaths(
  agentStorage: AgentStorage,
  branch: string,
): Promise<string[]> {
  const files = await agentStorage.listFiles([branch]);
  const prefix = `${branch}/`;
  return files.map((f) => (f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path));
}

/**
 * List the files under `baseDir`, folding in any OTHER branch whose routing
 * prefix is mounted INSIDE the listed directory (e.g. a `skills` branch at
 * `.agentplace/skills/` when listing `.agentplace`), so overlay branches are
 * visible in the tree.
 *
 * The DEFAULT adapter owns unprefixed paths, so its namespace is the storage root
 * (`""`) — NOT its routing prefix (which may be e.g. `source/`). Folding is gated
 * on the listed sub-path: a root/top-level listing (`subPath === ''`) never walks
 * sibling branches, preserving the single-branch listing contract for the common
 * case; only listing an ancestor directory of an overlay mount walks that overlay.
 */
export async function listDirRelativePaths(
  agentStorage: AgentStorage,
  baseDir: string,
): Promise<{ branch: string; subPath: string; relativePaths: string[] }> {
  const { adapter: branch, relativePath: subPath } = agentStorage.resolvePath(baseDir);
  const relativePaths = await listBranchRelativePaths(agentStorage, branch);

  if (subPath !== '') {
    const branchNamespace =
      branch === agentStorage.getDefaultAdapterName() ? '' : agentStorage.getRoutingPrefix(branch);
    const listedPrefix = `${subPath}/`;

    for (const name of agentStorage.getAdapterNames()) {
      if (name === branch) {
        continue;
      }
      const nestedPrefix = agentStorage.getRoutingPrefix(name);
      if (!nestedPrefix || !nestedPrefix.startsWith(branchNamespace)) {
        continue;
      }
      // Mount path relative to the primary branch root (e.g. ".agentplace/skills/").
      const rel = nestedPrefix.slice(branchNamespace.length);
      if (!rel.startsWith(listedPrefix)) {
        continue; // overlay mount is not inside the listed directory — skip (no walk)
      }
      const nestedFiles = await listBranchRelativePaths(agentStorage, name);
      for (const f of nestedFiles) {
        relativePaths.push(`${rel}${f}`);
      }
    }
  }

  return { branch, subPath, relativePaths };
}

/** True when `subPath` names a directory within `relativePaths` (has descendants). */
export function isDirectoryWithin(relativePaths: string[], subPath: string): boolean {
  if (subPath === '') {
    return relativePaths.length > 0;
  }
  const prefix = `${subPath}/`;
  return relativePaths.some((p) => p.startsWith(prefix));
}
