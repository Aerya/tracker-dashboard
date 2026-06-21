// ─── Templates de moteurs de trackers (mode guidé) ────────────────────────────
// Chaque template encode la structure login + fetch typique d'une famille de
// logiciels de tracker. Les valeurs proviennent des définitions réelles présentes
// dans config/trackers/ (Redacted pour Gazelle, Seedpool/TheOldSchool pour UNIT3D,
// TorrentLeech, MyAnonamouse, C411 pour l'API JSON) — pas de devinette.
//
// Un template fournit des DÉFAUTS pré-remplis dans le formulaire guidé : l'utilisateur
// n'a plus qu'à renseigner nom, URL et identifiants. Il peut tout ajuster ensuite.

import { type TrackerConfig, type EngineId } from './types.js';

export type { EngineId };

export interface EngineTemplate {
  id: EngineId;
  label: string;
  /** Description courte affichée dans le sélecteur du mode guidé. */
  description: string;
  /** Exemples de trackers connus tournant sous ce moteur (aide à la reconnaissance). */
  examples: string[];
  /** Aide spécifique : comment reconnaître ce moteur, où trouver les infos. */
  hint: string;
  /** Fragment de config pré-rempli (login + fetch + options), sans id/name/baseUrl. */
  preset: Pick<TrackerConfig, 'login' | 'fetch'> & Partial<Pick<TrackerConfig, 'curlBinary' | 'ratioless' | 'dashboard'>>;
}

export const ENGINE_TEMPLATES: Record<EngineId, EngineTemplate> = {
  unit3d: {
    id: 'unit3d',
    label: 'UNIT3D',
    description: 'Moteur moderne très répandu (interface épurée, barre de ratio en haut).',
    examples: ['Seedpool', 'Aither', 'Blutopia', 'GenerationFree', 'TheOldSchool'],
    hint: "Si la page de connexion affiche un formulaire « auth-form » et que ton profil montre une barre Uploaded/Downloaded/Ratio stylée, c'est UNIT3D. Login : ton nom d'utilisateur + mot de passe.",
    preset: {
      login: {
        url: 'login',
        method: 'POST',
        contentType: 'form',
        preStep: {
          url: 'login',
          includeHiddenInputs: true,
          extract: {
            _csrf: { regex: '(?:name="_token"[^>]*?\\svalue="|name="csrf-token"[^>]*?\\scontent=")(?<value>[^"]+)"' },
          },
        },
        body: {
          _token: '{{_csrf}}',
          username: '{{username}}',
          password: '{{password}}',
          remember: 'on',
        },
        failurePatterns: [
          'auth-form__form',
          'type="password"',
          'name="password"',
        ],
      },
      fetch: {
        url: '/',
        responseType: 'html',
        fields: {
          uploadedBytes:   { regex: 'ratio-bar__uploaded[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)', transform: 'bytes' },
          downloadedBytes: { regex: 'ratio-bar__downloaded[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)', transform: 'bytes' },
          ratio:           { regex: 'ratio-bar__ratio[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+)', transform: 'number' },
          seeding:         { regex: 'ratio-bar__seeding[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>\\d+)', transform: 'integer' },
          leeching:        { regex: 'ratio-bar__leeching[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>\\d+)', transform: 'integer' },
          seedBonus:       { regex: 'ratio-bar__points[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,\\u202f]+)', transform: 'string' },
          bufferBytes:     { regex: 'ratio-bar__buffer[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)', transform: 'bytes' },
          tokens:          { regex: 'ratio-bar__tokens[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>\\d+)', transform: 'integer' },
          // MP non lus : UNIT3D affiche une sphère animée (<animate>) près de l'icône
          // envelope quand il y a des MP non lus. Pas de compteur : on capture la durée
          // d'animation comme signal de présence ; toute valeur non vide => 1 MP.
          unreadMessages:  { regex: 'Boîte de réception(?:(?!<\\/a>)[\\s\\S])*?<animate[^>]*?dur="(?<value>[^"]+)"', transform: 'string' },
        },
      },
      dashboard: { byteUnit: 'binary' },
    },
  },

  gazelle: {
    id: 'gazelle',
    label: 'Gazelle',
    description: 'Moteur historique (musique/general), pages login.php / index.php.',
    examples: ['Redacted', 'Orpheus', 'BrokenStones', 'HD-Forever'],
    hint: "Si les URLs du site finissent en .php (login.php, index.php) et que tes stats sont en haut de page (Uploaded / Downloaded / Ratio), c'est Gazelle. Login : nom d'utilisateur + mot de passe.",
    preset: {
      login: {
        url: 'login.php',
        method: 'POST',
        contentType: 'form',
        preStep: { url: 'login.php', extract: {}, includeHiddenInputs: true },
        body: {
          username: '{{username}}',
          password: '{{password}}',
          keeplogged: '1',
          login: 'Log in',
        },
        failurePatterns: ['type="password"', 'name="password"'],
      },
      fetch: {
        url: 'index.php',
        mode: 'browser',
        responseType: 'html',
        fields: {
          uploadedBytes:   { regex: 'id="stats_seeding"[^>]*title="Uploaded: (?<value>[^"]+)"', transform: 'bytes' },
          downloadedBytes: { regex: 'id="stats_leeching"[^>]*title="Downloaded: (?<value>[^"]+)"', transform: 'bytes' },
          ratio:           { regex: 'id="stats_ratio"[^>]*title="Ratio: (?<value>[^"]+)"', transform: 'number' },
        },
      },
      dashboard: { byteUnit: 'binary' },
    },
  },

  jsonapi: {
    id: 'jsonapi',
    label: 'API JSON (avancé)',
    description: 'Tracker exposant une API JSON (login + stats en JSON, ex: C411).',
    examples: ['C411'],
    hint: "À choisir seulement si tu sais que le tracker expose une API JSON (login via /api/auth/login, stats via /api/auth/me…). Les champs s'extraient par chemin (ex: user.uploaded), pas par regex.",
    preset: {
      login: {
        url: 'login',
        postUrl: 'api/auth/login',
        method: 'POST',
        contentType: 'json',
        preStep: {
          url: 'login',
          extract: { _csrf: { regex: '<meta name="csrf-token" content="(?<value>[^"]+)"' } },
        },
        csrfHeader: 'csrf-token',
        body: { username: '{{username}}', password: '{{password}}' },
        successField: 'authenticated',
        failurePatterns: ['"message":"Unauthenticated', '"authenticated":false'],
      },
      fetch: {
        url: 'api/auth/me',
        mode: 'http',
        responseType: 'json',
        fields: {
          uploadedBytes:   { path: 'user.uploaded', transform: 'bytes' },
          downloadedBytes: { path: 'user.downloaded', transform: 'bytes' },
          ratio:           { path: 'user.ratio', transform: 'number' },
        },
      },
      dashboard: { byteUnit: 'decimal' },
    },
  },

  other: {
    id: 'other',
    label: 'Autre / inconnu',
    description: "Le moteur n'est pas dans la liste : formulaire guidé champ par champ, à remplir soi-même.",
    examples: [],
    hint: "On part d'un formulaire de login classique (nom d'utilisateur + mot de passe). Tu ajusteras les champs et les regex de stats selon ton site. Le bouton « Tester » t'aidera à valider.",
    preset: {
      login: {
        url: 'login.php',
        method: 'POST',
        contentType: 'form',
        body: { username: '{{username}}', password: '{{password}}' },
        failurePatterns: ['type="password"', 'name="password"'],
      },
      fetch: {
        url: '/',
        responseType: 'html',
        fields: {
          uploadedBytes:   { regex: '(?<value>[\\d.,]+\\s*[KMGTP]?i?B)', transform: 'bytes' },
          ratio:           { regex: 'Ratio[:\\s]*(?<value>[\\d.,]+)', transform: 'number' },
        },
      },
      dashboard: { byteUnit: 'decimal' },
    },
  },
};

/** Liste publique (pour l'UI) sans les presets volumineux. */
export function listEngines(): Array<Pick<EngineTemplate, 'id' | 'label' | 'description' | 'examples' | 'hint'>> {
  return Object.values(ENGINE_TEMPLATES).map(({ id, label, description, examples, hint }) => ({
    id, label, description, examples, hint,
  }));
}

export function getEngineTemplate(id: string): EngineTemplate | null {
  return (ENGINE_TEMPLATES as Record<string, EngineTemplate>)[id] ?? null;
}

/**
 * Applique le preset moteur (ENGINE_TEMPLATES) à une config qui déclare `engine`.
 * RÈGLE D'OR : le JSON du tracker gagne TOUJOURS sur le preset, champ par champ.
 * - login / dashboard / curlBinary / ratioless : fusion clé par clé, le JSON gagne.
 * - fetch.fields : MERGE field par field (preset puis JSON) pour qu'un site au skin
 *   modifié surcharge 2 fields sur 9 sans réécrire les 7 autres.
 * - fetch (hors fields) : le JSON gagne clé par clé.
 * Un tracker sans `engine` (ou engine inconnu) est renvoyé inchangé. Idempotent.
 *
 * IMPORTANT : cette fusion est appliquée à la LECTURE des configs
 * (loadTrackerConfigsFromDb), jamais persistée en base — la base ne contient que
 * les surcharges du JSON, le tronc commun reste dans le preset (source unique).
 */
export function applyEnginePreset(config: TrackerConfig): TrackerConfig {
  if (!config.engine) return config;
  const tpl = getEngineTemplate(config.engine);
  if (!tpl) return config;
  const preset = tpl.preset;

  const mergedLogin = { ...preset.login, ...config.login };
  const mergedFields = {
    ...(preset.fetch?.fields ?? {}),
    ...(config.fetch?.fields ?? {}),
  };
  const mergedFetch = { ...preset.fetch, ...config.fetch, fields: mergedFields };
  const mergedDashboard =
    config.dashboard || preset.dashboard
      ? { ...(preset.dashboard ?? {}), ...(config.dashboard ?? {}) }
      : undefined;

  return {
    ...config,
    curlBinary: config.curlBinary ?? preset.curlBinary,
    ratioless: config.ratioless ?? preset.ratioless,
    login: mergedLogin,
    fetch: mergedFetch,
    ...(mergedDashboard ? { dashboard: mergedDashboard } : {}),
  };
}

/**
 * Détecte le moteur à partir du HTML d'une page (login de préférence) et de l'URL.
 * Heuristiques basées sur des marqueurs distinctifs. Renvoie null si rien de sûr.
 * Volontairement conservateur : mieux vaut « inconnu » qu'un faux positif qui
 * pré-remplirait de mauvaises regex.
 */
export function detectEngineFromHtml(html: string, baseUrl: string): EngineId | null {
  const h = (html || '').toLowerCase();
  const url = (baseUrl || '').toLowerCase();

  // UNIT3D : classe de formulaire très spécifique + Laravel _token.
  if (h.includes('auth-form__form') || (h.includes('name="_token"') && h.includes('unit3d'))) {
    return 'unit3d';
  }
  // Gazelle : le champ "keeplogged" est très spécifique à Gazelle. On exige ce
  // marqueur précis plutôt qu'un simple "login.php + username + password" qui
  // matcherait beaucoup de moteurs maison (IPTorrents, TBDev, XBTit…).
  if (h.includes('name="keeplogged"') || h.includes("name='keeplogged'")) {
    return 'gazelle';
  }
  // UNIT3D (repli) : barre de ratio spécifique. On NE retombe PAS sur un
  // "auth-form" générique seul, trop ambigu.
  if (h.includes('ratio-bar__')) {
    return 'unit3d';
  }
  return null;
}
