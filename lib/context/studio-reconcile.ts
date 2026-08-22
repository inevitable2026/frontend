import { canonicalStudioJson, STUDIO_MANIFEST, type StudioContract, type StudioManifest } from "@/lib/context/studio-manifest";

export type StudioInventoryAgent = {
  id: string;
  name: string;
  ownershipMarker?: string;
  defaultConfigExternalId?: string | null;
  configFingerprint?: string | null;
  graph?: unknown;
};

export type ReconcileAction = "create" | "noop" | "drift" | "collision";
export type ReconcileItem = { kind: StudioContract["kind"]; agentLogicalName: string; action: ReconcileAction; reason: string };

export type StudioInventoryPage<T> = { items: T[]; nextCursor?: string | null; hasMore?: boolean };
export type StudioInventoryMetrics = { pages: number; items: number };

/** Collect a read-only cursor inventory without silently accepting incomplete pages. */
export async function collectStudioInventory<T>(
  readPage: (cursor?: string) => Promise<StudioInventoryPage<T>>,
  limits: { maxPages?: number; maxItems?: number } = {},
): Promise<{ items: T[]; metrics: StudioInventoryMetrics }> {
  const maxPages = limits.maxPages ?? 100;
  const maxItems = limits.maxItems ?? 10_000;
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(maxItems) || maxItems < 1) throw new Error("Studio inventory limits must be positive integers.");
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 1; pages <= maxPages; pages += 1) {
    const page = await readPage(cursor);
    if (!page || !Array.isArray(page.items)) throw new Error("Malformed Studio inventory page.");
    items.push(...page.items);
    if (items.length > maxItems) throw new Error("Studio inventory item limit exceeded.");
    const next = page.nextCursor ?? undefined;
    if (!page.hasMore && !next) return { items, metrics: { pages, items: items.length } };
    if (!next || cursors.has(next)) throw new Error("Studio inventory cursor is missing or repeated.");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("Studio inventory page limit exceeded.");
}

export function redactStudioSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStudioSnapshot);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(authorization|api[_-]?key|token|content|document|base64|attendee|amount|filename)/i.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, redactStudioSnapshot(child)]));
  }
  return value;
}

export function planStudioReconciliation(inventory: StudioInventoryAgent[], manifest: StudioManifest = STUDIO_MANIFEST): ReconcileItem[] {
  const byName = new Map<string, StudioInventoryAgent[]>();
  for (const agent of inventory) {
    if (!agent || typeof agent.id !== "string" || typeof agent.name !== "string") throw new Error("Malformed Studio inventory agent.");
    byName.set(agent.name, [...(byName.get(agent.name) ?? []), agent]);
  }
  return manifest.contracts.map((contract) => {
    const matches = byName.get(contract.agentLogicalName) ?? [];
    if (matches.length === 0) return { kind: contract.kind, agentLogicalName: contract.agentLogicalName, action: "create", reason: "missing owned resource" };
    if (matches.length > 1) return { kind: contract.kind, agentLogicalName: contract.agentLogicalName, action: "collision", reason: "duplicate logical name" };
    const agent = matches[0];
    if (agent.ownershipMarker !== manifest.ownership.marker) return { kind: contract.kind, agentLogicalName: contract.agentLogicalName, action: "collision", reason: "pre-existing name match is not adopted" };
    if (!contract.expectedConfigFingerprint || !agent.configFingerprint) return { kind: contract.kind, agentLogicalName: contract.agentLogicalName, action: "drift", reason: "missing immutable config fingerprint" };
    if (agent.configFingerprint !== contract.expectedConfigFingerprint) return { kind: contract.kind, agentLogicalName: contract.agentLogicalName, action: "drift", reason: "config fingerprint mismatch" };
    return { kind: contract.kind, agentLogicalName: contract.agentLogicalName, action: "noop", reason: "owned config fingerprint matches" };
  });
}

export function verifyStudioReconciliation(inventory: StudioInventoryAgent[], manifest: StudioManifest = STUDIO_MANIFEST): ReconcileItem[] {
  const plan = planStudioReconciliation(inventory, manifest);
  if (plan.some((item) => item.action !== "noop")) throw new Error(`Studio manifest verification failed: ${canonicalStudioJson(plan)}`);
  return plan;
}
