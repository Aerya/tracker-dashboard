export interface CrossSeedInstanceConfig {
  id: string;
  label: string;
  baseUrl: string;
  clientIds: string[];
  clientId?: string;
  markers: string[];
  enabled: boolean;
}

export const DEFAULT_CROSS_SEED_MARKERS = ['cross-seed-link', 'cross-seed'];

export function normalizeCrossSeedMarkers(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const markers = raw
    .map(marker => String(marker).trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(markers.length ? markers : DEFAULT_CROSS_SEED_MARKERS)];
}

export function normalizeCrossSeedClientIds(instance: { clientIds?: unknown; clientId?: unknown }): string[] {
  const raw = Array.isArray(instance.clientIds)
    ? instance.clientIds
    : [instance.clientId];
  return [...new Set(raw.map(clientId => String(clientId ?? '').trim()).filter(Boolean))];
}

function matchesMarker(value: string, marker: string): boolean {
  return value === marker || value.endsWith(`.${marker}`);
}

export function detectCrossSeedInstanceIds(
  instances: CrossSeedInstanceConfig[],
  clientId: string,
  category: unknown,
  tags: unknown,
): string[] {
  const normalizedCategory = String(category ?? '').trim().toLowerCase();
  const normalizedTags = (Array.isArray(tags) ? tags : String(tags ?? '').split(','))
    .map(tag => String(tag).trim().toLowerCase())
    .filter(Boolean);

  return instances
    .filter(instance => instance.enabled && normalizeCrossSeedClientIds(instance).includes(clientId))
    .filter(instance => normalizeCrossSeedMarkers(instance.markers).some(marker => (
      matchesMarker(normalizedCategory, marker)
      || normalizedTags.some(tag => matchesMarker(tag, marker))
    )))
    .map(instance => instance.id);
}

export function cleanCrossSeedBaseUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}
