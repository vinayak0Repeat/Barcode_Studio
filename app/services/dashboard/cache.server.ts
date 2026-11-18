interface CacheEntry {
  expiresAt: number;
  value: Promise<unknown>;
}

const values = new Map<string, CacheEntry>();

export function getOrCreateDashboardCache<T>(shopId: string, ttlMs: number, create: () => Promise<T>): Promise<T> {
  const cached = values.get(shopId);
  if (cached && cached.expiresAt > Date.now()) return cached.value as Promise<T>;

  const entry: CacheEntry = { expiresAt: Date.now() + ttlMs, value: create() };
  values.set(shopId, entry);
  void entry.value.catch(() => {
    if (values.get(shopId) === entry) values.delete(shopId);
  });
  return entry.value as Promise<T>;
}

export function invalidateDashboardSnapshot(shopId: string): void {
  values.delete(shopId);
}
