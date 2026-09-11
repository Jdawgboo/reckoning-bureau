export type DirectoryTreeNode = {
  name: string;
  children?: DirectoryTreeNode[];
};

export function buildTreeFromRelativeFileList(
  relativeFilePaths: string[],
  rootName: string,
): DirectoryTreeNode {
  const root: DirectoryTreeNode = { name: rootName, children: [] };

  for (const fullPath of relativeFilePaths.filter(Boolean)) {
    const parts = fullPath.split('/').filter(Boolean);
    let current = root;
    for (const part of parts) {
      if (!current.children) {
        current.children = [];
      }
      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part };
        current.children.push(child);
      }
      current = child;
    }
  }

  return root;
}

export function normalizeBaseDir(baseDir: string): string {
  return baseDir.replace(/^\.\//, '').replace(/^\//, '').replace(/\/$/, '');
}

export function filterStructure(
  structure: DirectoryTreeNode,
  baseDir: string,
  depth?: number,
): DirectoryTreeNode | null {
  const normalizedBaseDir = normalizeBaseDir(baseDir);

  if (!normalizedBaseDir || normalizedBaseDir === '.') {
    return depth ? limitDepth(structure, depth) : structure;
  }

  const parts = normalizedBaseDir.split('/').filter(Boolean);
  let current: DirectoryTreeNode | null = structure;

  for (const part of parts) {
    if (!current || !current.children) {
      return null;
    }
    const found: DirectoryTreeNode | undefined = current.children.find(
      (child) => child.name === part,
    );
    if (!found) {
      return null;
    }
    current = found;
  }

  return depth && current ? limitDepth(current, depth) : current;
}

export function limitDepth(
  node: DirectoryTreeNode,
  maxDepth: number,
  currentDepth = 0,
): DirectoryTreeNode {
  if (currentDepth >= maxDepth) {
    // Preserve folder indicator (empty children) so tree renderers can show trailing "/"
    return node.children ? { name: node.name, children: [] } : { name: node.name };
  }
  if (!node.children) {
    return node;
  }
  return {
    name: node.name,
    children: node.children.map((child) => limitDepth(child, maxDepth, currentDepth + 1)),
  };
}

/**
 * Names that are almost never useful to surface to the LLM when exploring an
 * agent project: build artifacts, dependency installs, VCS internals, IDE
 * metadata, macOS noise. Matched against `name` at every level of the tree —
 * a `node_modules` nested inside a dependency is pruned too.
 *
 * If the LLM specifically needs to look inside one of these (e.g. inspect a
 * vendored dep), it can still pass `baseDir: "node_modules/recharts"` and
 * filterStructure will descend through the pruned root.
 */
const DEFAULT_NOISE_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'build',
  'dist',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.DS_Store',
  '.vscode',
  '.idea',
]);

/**
 * Returns a copy of the tree with well-known noise directories pruned out at
 * every depth. Pure function — does not mutate the input.
 */
export function pruneNoiseDirs(
  node: DirectoryTreeNode,
  noiseNames: ReadonlySet<string> = DEFAULT_NOISE_NAMES,
): DirectoryTreeNode {
  if (!node.children) {
    return node;
  }
  return {
    name: node.name,
    children: node.children
      .filter((child) => !noiseNames.has(child.name))
      .map((child) => pruneNoiseDirs(child, noiseNames)),
  };
}

export function structureToText(node: DirectoryTreeNode, depth = 0): string {
  const INDENT = '  ';
  const lines: string[] = [];

  lines.push(`${INDENT.repeat(depth)}${node.name}${node.children ? '/' : ''}`);

  if (node.children && node.children.length > 0) {
    const sortedChildren = [...node.children].sort((a, b) => {
      const aIsDir = !!a.children;
      const bIsDir = !!b.children;
      if (aIsDir && !bIsDir) {
        return -1;
      }
      if (!aIsDir && bIsDir) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const child of sortedChildren) {
      lines.push(structureToText(child, depth + 1));
    }
  }

  return lines.join('\n');
}
