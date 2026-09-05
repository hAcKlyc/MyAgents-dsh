export interface WorkLineageNode {
  readonly agentId: string;
  readonly parentSessionId: string;
  readonly depth: number;
}

/** Read the one root-owned Work index; this function owns no registry or lifecycle. */
export const resolveWorkLineage = (
  rootId: string,
  targetId: string,
  lookup: (agentId: string) => WorkLineageNode | undefined,
): readonly WorkLineageNode[] => {
  const reversed: WorkLineageNode[] = [];
  const seen = new Set<string>();
  let current = targetId;
  while (current !== rootId) {
    if (seen.has(current) || reversed.length >= 8) throw new Error("Work lineage is cyclic or exceeds the supported depth");
    seen.add(current);
    const node = lookup(current);
    if (node?.agentId !== current || !Number.isSafeInteger(node.depth) || node.depth < 1 || node.depth > 8) {
      throw new Error("Work lineage lacks one exact root-owned node");
    }
    reversed.push(node);
    current = node.parentSessionId;
  }
  const path = reversed.reverse();
  if (path.some((node, index) => node.depth !== index + 1)) throw new Error("Work depth differs from its durable direct-parent chain");
  return Object.freeze(path);
};
