import {
  getJsonSetting,
  hasTrackerCookie,
  hasTrackerTotpSecret,
  importLegacyTrackersIfNeeded,
  listTrackerCredentialSummaries,
  loadDefaultTrackerDefinition,
  loadRawTrackerConfigsFromDb,
  saveTrackerConfig,
  setJsonSetting,
} from './db.js';

const V3X_CATALOG_MIGRATION_KEY = 'migration_v3x_catalog_availability_v1';

/**
 * Corrige les installations qui ont recu V3X pendant la courte periode ou sa
 * definition integree etait livree avec enabled=true.
 *
 * Le menu « Ajouter un tracker > Tracker integre » se base sur l'etat SQLite,
 * pas directement sur le JSON embarque. Une ancienne ligne v3x enabled=true
 * restait donc active meme apres le passage du fichier v3x.json a enabled=false.
 *
 * Cette migration est volontairement ciblee et executee une seule fois :
 * - pas de ligne V3X en base -> rien a corriger ;
 * - V3X deja desactive -> rien a corriger ;
 * - V3X avec credentials/cookie/TOTP -> on respecte l'activation utilisateur ;
 * - V3X actif sans aucune configuration -> on le remet dans le catalogue.
 */
export function migrateV3xCatalogAvailability(): void {
  const state = getJsonSetting(V3X_CATALOG_MIGRATION_KEY, { done: false });
  if (state.done) return;

  // Important : reproduit l'ordre de boot reel. Si une ancienne config JSON du
  // volume doit encore etre importee dans SQLite, elle l'est AVANT la correction.
  importLegacyTrackersIfNeeded();

  const bundled = loadDefaultTrackerDefinition('v3x');
  if (!bundled || bundled.enabled !== false) {
    // Ne pas marquer la migration terminee si l'image courante ne contient pas
    // encore la definition V3X attendue.
    return;
  }

  const existing = loadRawTrackerConfigsFromDb().find(config => config.id === 'v3x');
  if (!existing) {
    // Sans ligne SQLite, /api/tracker-definitions considere deja V3X non actif
    // et l'affiche dans « Ajouter un tracker ».
    setJsonSetting(V3X_CATALOG_MIGRATION_KEY, { done: true });
    return;
  }

  const credential = listTrackerCredentialSummaries().find(item => item.trackerId === 'v3x');
  const configured = Boolean(
    credential?.hasPassword
    || hasTrackerCookie('v3x')
    || hasTrackerTotpSecret('v3x')
  );

  if (existing.enabled !== false && !configured) {
    saveTrackerConfig({ ...existing, enabled: false });
    console.log('[Migration] V3X remis dans Ajouter un tracker > Tracker integre');
  }

  setJsonSetting(V3X_CATALOG_MIGRATION_KEY, { done: true });
}
