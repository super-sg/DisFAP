import { useCallback, useEffect, useState } from 'react';

import type { MarketplaceLicense, WorkspaceTemplate } from '../api/client.js';
import type { ApiClient } from '../api/client.js';

/**
 * The catalog the launch page browses: rentable licenses and base workspaces.
 *
 * Both fetches are independent and non-fatal: an empty marketplace must not
 * stop someone launching a base workspace (and vice versa), so a failed load
 * degrades to `[]` for that list rather than blanking the page.
 */
export interface Catalog {
  licenses: MarketplaceLicense[] | null;
  templates: WorkspaceTemplate[] | null;
  loadError: string | null;
  /** Re-read the license list (e.g. after publishing a listing). */
  refreshLicenses: () => Promise<void>;
}

export function useCatalog(api: ApiClient): Catalog {
  const [licenses, setLicenses] = useState<MarketplaceLicense[] | null>(null);
  const [templates, setTemplates] = useState<WorkspaceTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listLicenses().catch(() => []), api.listTemplates().catch(() => [])])
      .then(([lics, tmpls]) => {
        if (cancelled) return;
        setLicenses(lics);
        setTemplates(tmpls);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load catalog');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const refreshLicenses = useCallback(async () => {
    const lics = await api.listLicenses().catch(() => []);
    setLicenses(lics);
  }, [api]);

  return { licenses, templates, loadError, refreshLicenses };
}
