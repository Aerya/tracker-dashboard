import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { fetchTracker, invalidateAllSessions, invalidateSession } from './fetcher.js';
import { resetBrowserProfile, closeBrowserSession } from './browserFetcher.js';
import { type FieldExtractor, type TrackerConfig, type TrackerStats } from './types.js';
import {
  loadProxySettings, saveProxySettings, buildProxyConfig, logProxyStatus, resolveProxyForTracker, ensureProxyReady,
  loadProxyOverrides, saveProxyOverrides, toSshConfig,
  type ProxySettings, type ProxyOverride,
} from './proxy.js';
import { ensureSshSocks } from './sshTunnel.js';
import crypto from 'crypto';
import {
  loadIncidents, setIncident, getIncident, clearIncident,
} from './incidents.js';
import {
  resolveLogoPath, refreshAllLogos, listTrackersWithoutLogo,
} from './logos.js';
import {
  deleteTrackerCredentials,
  getTrackerCredentials,
  importLegacyCredentialsIfNeeded,
  importLegacySettingsIfNeeded,
  importLegacyTrackersIfNeeded,
  getJsonSetting,
  getLatestOkStatSnapshot,
  listStatSnapshots,
  listTrackerCredentialSummaries,
  listTrackerDefinitionFiles,
  listTrackerSchedules,
  loadCredentialsFromDb,
  loadTrackerConfigsFromDb,
  loadTrackerDefinitionFile,
  loadDefaultTrackerDefinition,
  saveStatSnapshots,
  saveTrackerCredentials,
  saveTrackerConfig,
  setJsonSetting,
  hasTrackerCookie,
  setTrackerCookie,
  hasTrackerTotpSecret,
  setTrackerTotpSecret,
} from './db.js';
import {
  createSessionCookie,
  isAuthConfigured,
  readCookie,
  saveAuthSettings,
  verifyLogin,
  verifySessionCookie,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'tracker_dashboard_session';
const TRACKER_DEFINITIONS_SEEN_KEY = 'trackerDefinitionsSeen';
const PRESENTATION_MODE_KEY = 'presentationMode';
const TRACKER_ORDER_KEY = 'trackerOrder';

function readAppVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function shortRevision(revision: string): string {
  return /^[0-9a-f]{7,40}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

function startupBanner(port: number): string {
  const appVersion = readAppVersion();
  const imageSource = process.env.APP_IMAGE_SOURCE?.trim() || 'local';
  const imageVersion = process.env.APP_IMAGE_VERSION?.trim() || 'dev';
  const imageRevision = process.env.APP_IMAGE_REVISION?.trim() || 'unknown';
  const imageRef = process.env.APP_IMAGE_REF?.trim() || 'local';
  const revisionShort = shortRevision(imageRevision);
  const comparableTag = /^[0-9a-f]{7,40}$/i.test(imageRevision)
    ? `sha-${revisionShort}`
    : 'unknown';

  return [
    '',
    `Tracker Dashboard v${appVersion}`,
    `Image: ${imageSource}:${imageVersion}`,
    `Build ref: ${imageRef}`,
    `Build revision: ${revisionShort}`,
    `Comparable GHCR tag: ${comparableTag}`,
    'GHCR: https://github.com/Tracker-Dashboard/tracker-dashboard/pkgs/container/tracker-dashboard',
    `🚀  Dashboard → http://localhost:${port}`,
    '',
  ].join('\n');
}

// ─── Chargement trackers / credentials ───────────────────────────────────────

// ─── State ────────────────────────────────────────────────────────────────────

let cachedStats: TrackerStats[] = [];
let lastRefresh: string | null  = null;
let isRefreshing                = false;
const pendingScheduledRuns = new Set<string>();

interface BetaQbitClient {
  id: string;
  type?: 'qbittorrent' | 'rutorrent';
  label: string;
  baseUrl: string;
  username?: string;
  password?: string;
  enabled: boolean;
  // Intervalle de rafraîchissement automatique en minutes (par client), saisi
  // côté WebUI en jours et/ou heures (combinables). 0 (ou absent) = pas de rescan
  // automatique ; sinon le scheduler rescanne ce client toutes les N minutes.
  // Plafonné à 43200 (30 jours) à l'enregistrement.
  refreshMinutes?: number;
}

interface BetaNotificationTarget {
  id: string;
  type: 'discord' | 'apprise';
  label: string;
  url: string;
  urls?: string[];
  enabled: boolean;
}

interface BetaScheduleSettings {
  enabled: boolean;
  mode: 'hours' | 'days' | 'weekdays';
  intervalHours: number;
  intervalDays: number;
  hour: number;
  minute: number;
  weekdays: number[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastFailedTrackerIds: string[];
}

interface BetaNotificationPreferences {
  notifyError: boolean;
  notifySuccess: boolean;
  notifySuccessAfterFailure: boolean;
  notifyStats: boolean;
}

interface BetaTrackerScheduleOverride {
  trackerId: string;
  mode: 'global' | 'disabled' | 'interval';
  intervalHours: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

interface BetaAlertRule {
  id: string;
  trackerId: string;
  enabled: boolean;
  kind: 'ratio' | 'buffer' | 'seedtime' | 'cookie' | 'site';
  operator: '<=' | '<' | '>=' | '>' | 'expired' | 'soon' | 'down';
  threshold: number;
  targetIds: string[];
}

interface BetaAnnounceMapping {
  announceHost: string;
  trackerId: string;
}

interface BetaSettings {
  qbitClients: BetaQbitClient[];
  announceMappings: BetaAnnounceMapping[];
  notificationTargets: BetaNotificationTarget[];
  schedule: BetaScheduleSettings;
  scheduleOverrides: BetaTrackerScheduleOverride[];
  notificationPreferences: BetaNotificationPreferences;
  alertRules: BetaAlertRule[];
  defaults: {
    ratioEnabled: boolean;
    ratioThreshold: number;
    cookieDays: number;
    siteDownEnabled: boolean;
  };
}

interface QbitTrackerAggregate {
  clientId: string;
  clientLabel: string;
  clientBaseUrl: string;
  trackerHost: string;
  torrentCount: number;
  seedingCount: number;
  leechingCount: number;
  uploadedBytes: number;
  downloadedBytes: number;
  ratio: number | null;
  totalSizeBytes: number;
  torrents: Array<{
    hash: string;
    name: string;
    state: string;
    progress: number;
    sizeBytes: number;
    uploadedBytes: number;
    downloadedBytes: number;
    ratio: number | null;
  }>;
}

const BETA_SETTINGS_KEY = 'beta_settings';
let betaQbitStats: QbitTrackerAggregate[] = [];
let betaQbitLastRefresh: string | null = null;
// Horodatage (epoch ms) du dernier scan par client, pour piloter le
// rafraîchissement automatique par intervalle (en mémoire, comme betaQbitStats).
const qbitClientLastScan = new Map<string, number>();

const unit3dFields = knownUnit3dFields();
const gazelleStatsFields = knownGazelleStatsFields();

function knownUnit3dFields(): Record<string, FieldExtractor> {
  return {
    uploadedBytes: {
      regex: 'ratio-bar__uploaded[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)',
      transform: 'bytes',
    },
    downloadedBytes: {
      regex: 'ratio-bar__downloaded[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)',
      transform: 'bytes',
    },
    ratio: {
      regex: 'ratio-bar__ratio[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+)',
      transform: 'number',
    },
    seeding: {
      regex: 'ratio-bar__seeding[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>\\d+)',
      transform: 'integer',
    },
    leeching: {
      regex: 'ratio-bar__leeching[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>\\d+)',
      transform: 'integer',
    },
    seedBonus: {
      regex: 'ratio-bar__points[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,\\u202f]+)',
      transform: 'string',
    },
    bufferBytes: {
      regex: 'ratio-bar__buffer[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)',
      transform: 'bytes',
    },
    tokens: {
      regex: 'ratio-bar__tokens[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>\\d+)',
      transform: 'integer',
    },
    // MP non lus : UNIT3D affiche une sphère animée (<animate>) près de l'icône envelope
    // dans le bloc "conversations" quand il y a des MP non lus, rien sinon.
    // Pas de compteur disponible → on capture la durée de l'animation ("1s") comme
    // signal de présence ; unreadMessagesCount() mappe toute string non vide → 1.
    unreadMessages: {
      regex: 'Boîte de réception(?:(?!<\\/a>)[\\s\\S])*?<animate[^>]*?dur="(?<value>[^"]+)"',
      transform: 'string',
    },
  };
}

function knownGazelleStatsFields(): Record<string, FieldExtractor> {
  return {
    seedBonus: {
      regex: '>Credits</a>:\\s*</td>[\\s\\S]{0,140}?<span[^>]*class=[\'"]stat[\'"][^>]*>\\s*(?<value>[\\d\\s.,]+)',
      transform: 'string',
    },
    uploadedBytes: {
      regex: '>Up</a>:\\s*</td>[\\s\\S]{0,160}?<span[^>]*class=[\'"]stat[\'"][^>]*>\\s*(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))',
      transform: 'bytes',
    },
    downloadedBytes: {
      regex: '>Down</a>:\\s*</td>[\\s\\S]{0,160}?<span[^>]*class=[\'"]stat[\'"][^>]*>\\s*(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))',
      transform: 'bytes',
    },
    ratio: {
      regex: '>Ratio</a>:\\s*</td>[\\s\\S]{0,220}?<span[^>]*class=[\'"]r\\d+[\'"][^>]*>\\s*(?<value>\\d[\\d\\s.,]*)',
      transform: 'number',
    },
  };
}

const knownTrackerFields: Record<string, {
  fetchUrl?: string;
  mode?: 'http' | 'browser';
  byteUnit?: 'binary' | 'decimal';
  ratioless?: boolean;
  fields: Record<string, FieldExtractor>;
}> = {
  hdonly: {
    fetchUrl: 'index.php',
    byteUnit: 'decimal',
    ratioless: true,
    fields: {
      uploadedBytes: {
        regex: 'Envoy[\\s\\S]{0,160}?(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'Re[\\s\\S]{0,160}?(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)',
        transform: 'bytes',
      },
      // MP non lus : skin Gazelle identique à HDForever (gazelle-notification +
      // data-notification-type="Inbox"). A confirmer par Aerya si skin différente.
      unreadMessages: {
        regex: 'data-notification-type=[\'"]Inbox[\'"][^>]*>[^<]*?(?<value>\\d+|\\bun) nouveau',
        transform: 'string',
      },
    },
  },
  hdforever: {
    fetchUrl: 'index.php',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: 'class="stat tooltip up" title="(?<value>[^"]+)"',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'class="stat tooltip dl" title="(?<value>[^"]+)"',
        transform: 'bytes',
      },
      ratio: {
        regex: 'stats_ratio[^>]*>Ratio[^<]*<[^>]*><span class="tooltip r\\d+" title="(?<value>[^"]+)"',
        transform: 'number',
      },
      seedBonus: {
        regex: 'action=rate[^>]+>(?<value>[\\d,]+)<',
        transform: 'string',
      },
      // MP non lus : skin Gazelle "gazelle-notification" + data-notification-type="Inbox".
      // FR : "Vous avez 2 nouveaux messages" mais "Vous avez un nouveau message" (singulier
      // = mot, pas chiffre). On capte \d+ OU "un" UNIQUEMENT s'il est suivi de " nouveau"
      // et precede d'une frontiere de mot (\b) -> evite "aucun" ou un "un" egare.
      // transform 'string' pour preserver "un" ; le front mappe un/une -> 1.
      unreadMessages: {
        regex: 'data-notification-type=[\'"]Inbox[\'"][^>]*>[^<]*?(?<value>\\d+|\\bun) nouveau',
        transform: 'string',
      },
    },
  },
  theoldschool: {
    fetchUrl: '/',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  generationfree: {
    fetchUrl: '/',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  teamflix: {
    fetchUrl: '/',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  g3mini: {
    fetchUrl: '/',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  seedpool: {
    fetchUrl: '/',
    mode: 'browser',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  sextorrent: {
    fetchUrl: '/',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  bitporn: {
    fetchUrl: '/',
    mode: 'browser',
    byteUnit: 'binary',
    fields: {
      // BitPorn enrobe la valeur dans un <a href=".../uploads"> et utilise un espace
      // insecable ( ) -> on ancre sur la classe et on capture juste nombre+unite.
      uploadedBytes: {
        regex: 'ratio-bar__uploaded[\\s\\S]{0,260}?(?<value>\\d[\\d.,]*(?:&nbsp;|&#160;|&#xa0;|[\\s\\u00a0])*[KMGTPE]i?B)',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'ratio-bar__downloaded[\\s\\S]{0,260}?(?<value>\\d[\\d.,]*(?:&nbsp;|&#160;|&#xa0;|[\\s\\u00a0])*[KMGTPE]i?B)',
        transform: 'bytes',
      },
      ratio: unit3dFields.ratio,
      seeding: unit3dFields.seeding,
      seedBonus: unit3dFields.seedBonus,
      bufferBytes: {
        regex: 'ratio-bar__buffer[\\s\\S]{0,260}?(?<value>\\d[\\d.,]*(?:&nbsp;|&#160;|&#xa0;|[\\s\\u00a0])*[KMGTPE]i?B)',
        transform: 'bytes',
      },
    },
  },
  exoticaz: {
    fetchUrl: '/',
    mode: 'browser',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes:   { regex: 'fa-arrow-up[\\s\\S]{0,40}?</i>\\s*(?<value>[\\d.,]+\\s*[KMGTPE]?i?B)',   transform: 'bytes' },
      downloadedBytes: { regex: 'fa-arrow-down[\\s\\S]{0,40}?</i>\\s*(?<value>[\\d.,]+\\s*[KMGTPE]?i?B)', transform: 'bytes' },
      ratio:           { regex: 'fa-signal[\\s\\S]{0,40}?</i>\\s*(?<value>[\\d.,]+)',                     transform: 'number' },
      bufferBytes:     { regex: 'fa-database[\\s\\S]{0,40}?</i>\\s*(?<value>[\\d.,]+\\s*[KMGTPE]?i?B)',    transform: 'bytes' },
      seeding:         { regex: 'Seeding:</a>\\s*(?<value>\\d+)',                                          transform: 'integer' },
      seedBonus:       { regex: 'Bonus:</a>\\s*(?<value>[\\d.,]+)',                                        transform: 'string' },
    },
  },
  abnormal: {
    fetchUrl: '/',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: 'Up\\s*:[\\s\\S]{0,360}?text-green[\\s\\S]{0,120}?(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B))',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'Down\\s*:[\\s\\S]{0,360}?text-green[\\s\\S]{0,120}?(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B))',
        transform: 'bytes',
      },
      ratio: {
        regex: 'Ratio\\s*:[\\s\\S]{0,360}?text-green[\\s\\S]{0,120}?(?<value>[\\d\\s.,]+)',
        transform: 'number',
      },
      seedBonus: {
        regex: "Choco's\\s*:[\\s\\S]{0,360}?text-green[\\s\\S]{0,120}?(?<value>[\\d\\s.,]+)",
        transform: 'string',
      },
      // MP : notification maison "Vous avez N nouveau(x) message(s)." (signal ephemere,
      // efface une fois "Voir"/"Je m'en fous" clique cote ABN). Capte \d+ OU "un" (au cas
      // ou ABN ecrit le singulier en lettres), ancre sur "nouveau(x) message", \b anti-"aucun".
      unreadMessages: {
        regex: '(?<value>\\d+|\\bun) nouveau\\(x\\) message',
        transform: 'string',
      },
    },
  },
  yggreborn: {
    fetchUrl: 'account/',
    mode: 'browser',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: '(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*</div>[\\s\\S]{0,180}?>Upload<',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: '(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*</div>[\\s\\S]{0,180}?>Download<',
        transform: 'bytes',
      },
    },
  },
  tr4ker: {
    fetchUrl: '/',
    mode: 'browser',
    byteUnit: 'decimal',
    fields: {
      ratio: {
        regex: 'RATIO\\s*:?\\s*(?<value>[\\d\\s.,]+)',
        transform: 'number',
      },
      uploadedBytes: {
        regex: '>UPLOAD<[\\s\\S]{0,180}?_statValue[^>]*>\\s*(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*<',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: '>DOWNLOAD<[\\s\\S]{0,180}?_statValue[^>]*>\\s*(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*<',
        transform: 'bytes',
      },
    },
  },
  lacale: {
    fetchUrl: 'profile',
    mode: 'browser',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: '\\\\?"uploaded\\\\?"\\s*:\\s*(?<value>\\d+)',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: '\\\\?"downloaded\\\\?"\\s*:\\s*(?<value>\\d+)',
        transform: 'bytes',
      },
      seedBonus: {
        regex: '\\\\?"bonusPoints\\\\?"\\s*:\\s*(?<value>\\d+)',
        transform: 'string',
      },
    },
  },
  crazyspirits: {
    fetchUrl: '/',
    mode: 'browser',
    byteUnit: 'binary',
    fields: {
      downloadedBytes: {
        regex: '/dl\\.png"[\\s\\S]{0,160}?<font[^>]*>\\s*(?<value>[\\d.,]+\\s*[KMGTPE]?i?B)',
        transform: 'bytes',
      },
      uploadedBytes: {
        regex: '/up\\.png"[\\s\\S]{0,160}?<font[^>]*>\\s*(?<value>[\\d.,]+\\s*[KMGTPE]?i?B)',
        transform: 'bytes',
      },
      seedBonus: {
        regex: 'Crazy Bonus\\s*<a[^>]*>\\s*(?<value>[\\d\\s.,]+)',
        transform: 'string',
      },
    },
  },
  tigersdl: {
    fetchUrl: 'mybonus.php',
    mode: 'browser',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: 'title=[\'"]Partager[\'"][\\s\\S]{0,180}?<font[^>]*>\\s*(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*</font>',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'title=[\'"][^\'"]*charg[^\'"]*[\'"][\\s\\S]{0,180}?<font[^>]*>\\s*(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*</font>',
        transform: 'bytes',
      },
      seedBonus: {
        regex: 'Votre solde[\\s\\S]{0,180}?score-points[^>]*>\\s*(?<value>[\\d\\s.,]+)',
        transform: 'string',
      },
      seeding: {
        regex: '(?:Nombres de Torrents que vous avez en seed\\s*:\\s*|title=[\'"]Seeding[\'"][\\s\\S]{0,120}?<b>\\s*)(?<value>\\d+)',
        transform: 'integer',
      },
    },
  },
  mam: {
    fetchUrl: 'u/',
    mode: 'browser',
    byteUnit: 'binary',
    fields: {
      uploadedBytes: {
        regex: 'Uploaded[\\s\\S]{0,160}?(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'Downloaded[\\s\\S]{0,160}?(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))',
        transform: 'bytes',
      },
      ratio: {
        regex: 'Share ratio[\\s\\S]{0,160}?(?<value>\\d[\\d\\s.,]*)',
        transform: 'number',
      },
      seedBonus: {
        regex: 'Bonus[\\s\\S]{0,160}?(?<value>[\\d\\s.,]+)',
        transform: 'string',
      },
    },
  },
  milkie: {
    fetchUrl: 'browse',
    mode: 'browser',
    byteUnit: 'binary',
    fields: {
      uploadedBytes: {
        regex: 'keyboard_arrow_up[\\s\\S]{0,140}?(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'keyboard_arrow_down[\\s\\S]{0,140}?(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))',
        transform: 'bytes',
      },
    },
  },
  speedapp: {
    fetchUrl: 'profile',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: 'Uploaded[\\s\\S]{0,120}?<dd[^>]*>\\s*(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*</dd>',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'Downloaded[\\s\\S]{0,120}?<dd[^>]*>\\s*(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*</dd>',
        transform: 'bytes',
      },
      seedTimeDays: {
        regex: 'Seed time[\\s\\S]{0,120}?<dd[^>]*>\\s*(?<value>\\d[\\d\\s.,]*)\\s*days',
        transform: 'number',
      },
    },
  },
  kufirc: {
    fetchUrl: 'index.php',
    mode: 'browser',
    byteUnit: 'binary',
    fields: gazelleStatsFields,
  },
  happyfappy: {
    fetchUrl: 'index.php',
    mode: 'browser',
    byteUnit: 'binary',
    fields: gazelleStatsFields,
  },
  empornium: {
    fetchUrl: 'index.php',
    mode: 'browser',
    byteUnit: 'binary',
    fields: gazelleStatsFields,
  },
  nostradamus: {
    fetchUrl: 'activity',
    mode: 'browser',
    byteUnit: 'decimal',
    ratioless: true,
    fields: {
      uploadedBytes: {
        regex: '>\\s*Upload total\\s*<[\\s\\S]{0,400}?>\\s*(?<value>\\d[\\d.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*<',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: '>\\s*Download total\\s*<[\\s\\S]{0,400}?>\\s*(?<value>\\d[\\d.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*<',
        transform: 'bytes',
      },
      points: {
        regex: 'hero-banknotes[\\s\\S]*?sidebar-account-stat__value[^>]*>\\s*(?<value>[\\d\\s.,]+)',
        transform: 'integer',
      },
      rate: {
        regex: 'hero-bolt[\\s\\S]*?sidebar-account-stat__value[^>]*>\\s*(?<value>[\\d\\s.,]+)',
        transform: 'number',
      },
    },
  },
};

// Trackers dont le login ne peut pas etre automatise (CAPTCHA, Cloudflare Turnstile,
// plafond de sessions...) : on force le mode "cookie uniquement".
const COOKIE_ONLY_TRACKERS = new Set([
  'mam',          // plafond de sessions + login bloque
  'seedpool',     // CAPTCHA au login (UNIT3D)
  'bitporn',      // Cloudflare
  'exoticaz',     // CAPTCHA
  'crazyspirits', // Cloudflare Turnstile
  'tr4ker',       // Cloudflare + login SPA
  'yggreborn',    // Cloudflare Turnstile
]);
function normalizeTrackerConfigs(): TrackerConfig[] {
  const trackers = loadTrackerConfigsFromDb();
  for (const tracker of trackers) {
    let changed = false;
    // Les champs techniques (login, fetch, curlBinary) font autorite cote image :
    // on les relit depuis la definition embarquee dans l'image (default-trackers/,
    // toujours a jour avec la version deployee) et on reinjecte en base si differents.
    // La copie sur le volume (config/trackers/) n'est jamais rafraichie apres la 1re
    // ecriture, donc on ne s'y fie pas. Un tracker absent de l'image (purement local)
    // n'est pas touche : loadDefaultTrackerDefinition renvoie null.
    // Sans ce mecanisme, une install deployee garde eternellement les vieilles
    // definitions en base, meme apres une mise a jour d'image qui les corrige.
    const definition = loadDefaultTrackerDefinition(tracker.id);
    if (definition) {
      if (JSON.stringify(tracker.login) !== JSON.stringify(definition.login)) {
        tracker.login = definition.login;
        changed = true;
      }
      if (JSON.stringify(tracker.fetch) !== JSON.stringify(definition.fetch)) {
        tracker.fetch = definition.fetch;
        changed = true;
      }
      if (tracker.curlBinary !== definition.curlBinary) {
        tracker.curlBinary = definition.curlBinary;
        changed = true;
      }
    }
    const isHdOnlyLikeTracker = ['hdonly', 'hdforever'].includes(tracker.id);
    const isUnit3dTracker = ['theoldschool', 'generationfree', 'teamflix', 'g3mini', 'seedpool', 'bitporn', 'sextorrent'].includes(tracker.id);
    if (tracker.id === 'hdonly' && tracker.login.failurePatterns.includes('login.php')) {
      tracker.login.failurePatterns = tracker.login.failurePatterns
        .filter(pattern => pattern !== 'login.php');
      changed = true;
    }
    if (isHdOnlyLikeTracker) {
      tracker.login.preStep = {
        url: 'login.php',
        extract: {},
        includeHiddenInputs: true,
      };
      tracker.login.failurePatterns = [
        ...new Set([
          ...tracker.login.failurePatterns,
          'type="password"',
          'href="login.php"',
          'Entrer</a>',
        ]),
      ];
      changed = true;
    }
    if (tracker.id === 'hdonly') {
      tracker.login.body = {
        username: '{{username}}',
        password: '{{password}}',
        keeplogged: '1',
        login: 'Se connecter',
      };
      changed = true;
    }
    if (isUnit3dTracker) {
      tracker.login.preStep = {
        url: tracker.login.preStep?.url ?? 'login',
        includeHiddenInputs: true,
        // CSRF robuste : accepte l'input cache <input name="_token" value="..."> OU
        // le <meta name="csrf-token" content="..."> du <head> (selon le rendu UNIT3D).
        extract: {
          _csrf: { regex: '(?:name="_token"[^>]*?\\svalue="|name="csrf-token"[^>]*?\\scontent=")(?<value>[^"]+)"' },
        },
      };
      tracker.login.body = {
        _token: '{{_csrf}}',
        username: '{{username}}',
        password: '{{password}}',
        remember: 'on',
      };
      // Jeu CURÉ et fiable : ces marqueurs n'apparaissent QUE sur la page de login
      // UNIT3D, jamais sur une page connectée. On ECRASE (pas de merge) pour eliminer
      // les patterns trop larges venant des JSON (ex: "Bejelentkezés"/"Se connecter"
      // qui figurent dans un menu meme connecte -> faux "non authentifie").
      tracker.login.failurePatterns = [
        'auth-form__form',
        'type="password"',
        'name="password"',
      ];
      changed = true;
    }
    if (tracker.id === 'abnormal') {
      if (tracker.login.url !== 'Home/Login') {
        tracker.login.url = 'Home/Login';
        changed = true;
      }
      tracker.login.preStep = {
        ...(tracker.login.preStep ?? { url: 'Home/Login', extract: {} }),
        url: 'Home/Login',
        includeHiddenInputs: true,
      };
      tracker.login.failurePatterns = [
        ...new Set([
          ...tracker.login.failurePatterns,
          'id="account"',
          'type="password"',
          'Connexion - ABN',
        ]),
      ];
      changed = true;
    }
    if (tracker.id === 'nostradamus') {
      if (tracker.login.url !== 'sign-in') {
        tracker.login.url = 'sign-in';
      }
      tracker.login.body = {
        password: '{{password}}',
      };
      tracker.login.failurePatterns = [
        'type="password"',
        'private-key-input',
        'name="password"',
        'name="username"',
        'Se connecter',
      ];
      changed = true;
    }
    if (tracker.id === 'tr4ker') {
      tracker.login.failurePatterns = [
        ...new Set([
          ...tracker.login.failurePatterns,
          'href="/login"',
          'aria-label="Connexion"',
          'Inscription',
        ]),
      ];
      changed = true;
    }
    if (tracker.id === 'phoenixproject') {
      if (tracker.curlBinary !== 'curl_firefox135') {
        tracker.curlBinary = 'curl_firefox135';
        changed = true;
      }
      if (tracker.login.cookieOnly) {
        tracker.login.cookieOnly = false;
        changed = true;
      }
    }
    if (tracker.id === 'tigersdl') {
      if (tracker.login.url !== 'account-login.php') {
        tracker.login.url = 'account-login.php';
      }
      tracker.login.body = {
        username: '{{username}}',
        password: '{{password}}',
      };
      tracker.login.failurePatterns = [
        'account-login.php',
        'type="password"',
        'type=\'password\'',
        'name="password"',
        'name=\'password\'',
      ];
      changed = true;
    }
    if (tracker.id === 'mam') {
      if (tracker.login.url !== 'login.php?returnto=%2Fu%2F') {
        tracker.login.url = 'login.php?returnto=%2Fu%2F';
      }
      tracker.login.preStep = {
        url: 'login.php?returnto=%2Fu%2F',
        extract: {},
        includeHiddenInputs: true,
      };
      tracker.login.body = {
        email: '{{username}}',
        password: '{{password}}',
        rememberMe: 'yes',
        returnto: '/u/',
      };
      tracker.login.failurePatterns = [
        'Not logged in!',
        'Login | My Anonamouse',
        'name="password"',
        'name=\'password\'',
        'loginIssueBlock',
      ];
      changed = true;
    }
    // Trackers a CAPTCHA / Cloudflare Turnstile / anti-bot : le login formulaire est
    // impossible a automatiser -> cookie de session uniquement (jamais de soumission
    // de formulaire). Force le flag meme si la config en base est ancienne.
    if (COOKIE_ONLY_TRACKERS.has(tracker.id) && !tracker.login.cookieOnly) {
      tracker.login.cookieOnly = true;
      changed = true;
    }
    if (tracker.id === 'milkie') {
      if (tracker.login.url !== 'auth/signin') {
        tracker.login.url = 'auth/signin';
      }
      tracker.login.body = {
        email: '{{username}}',
        password: '{{password}}',
      };
      tracker.login.failurePatterns = [
        '/auth/signin',
        'type="password"',
        'type=\'password\'',
        'name="password"',
        'name=\'password\'',
      ];
      changed = true;
    }
    if (tracker.id === 'speedapp') {
      if (tracker.login.url !== 'fr/connexion?locale=fr') {
        tracker.login.url = 'fr/connexion?locale=fr';
      }
      tracker.login.preStep = {
        url: 'fr/connexion?locale=fr',
        extract: {},
        includeHiddenInputs: true,
      };
      tracker.login.body = {
        username: '{{username}}',
        password: '{{password}}',
        _remember_me: 'on',
      };
      tracker.login.failurePatterns = [
        'Connexion | SpeedApp',
        'name="username"',
        'name="password"',
        'name=\'_csrf_token\'',
      ];
      changed = true;
    }
    if (['kufirc', 'happyfappy', 'empornium'].includes(tracker.id)) {
      if (tracker.login.url !== 'login') {
        tracker.login.url = 'login';
      }
      tracker.login.preStep = {
        url: 'login',
        extract: {},
        includeHiddenInputs: true,
      };
      tracker.login.body = {
        username: '{{username}}',
        password: '{{password}}',
        keeploggedin: '1',
      };
      tracker.login.failurePatterns = [
        'Login ::',
        'name="password"',
        'id="login_button"',
        'href="/login"',
      ];
      changed = true;
    }
    if (tracker.id === 'yggreborn') {
      if (tracker.login.url !== 'login?next=/account/') {
        tracker.login.url = 'login?next=/account/';
      }
      tracker.login.body = {
        identifier: '{{username}}',
        password: '{{password}}',
      };
      tracker.login.failurePatterns = [
        'type="password"',
        'name="password"',
        'name="identifier"',
        'cf-turnstile',
        'Connexion à ton compte',
      ];
      changed = true;
    }
    const known = knownTrackerFields[tracker.id];
    if (known) {
      if (known.mode && tracker.fetch.mode !== known.mode) {
        tracker.fetch.mode = known.mode;
        changed = true;
      }
      if (known.fetchUrl && tracker.fetch.url !== known.fetchUrl) {
        tracker.fetch.url = known.fetchUrl;
        changed = true;
      }
      if (JSON.stringify(tracker.fetch.fields) !== JSON.stringify(known.fields)) {
        tracker.fetch.fields = known.fields;
        changed = true;
      }
      if (known.byteUnit && tracker.dashboard?.byteUnit !== known.byteUnit) {
        tracker.dashboard = { ...(tracker.dashboard ?? {}), byteUnit: known.byteUnit };
        changed = true;
      }
      if (typeof known.ratioless === 'boolean' && tracker.ratioless !== known.ratioless) {
        tracker.ratioless = known.ratioless;
        changed = true;
      }
    }
    if (changed) saveTrackerConfig(tracker);
  }
  return loadTrackerConfigsFromDb();
}

function proxyAllowsTrackerConnections(): boolean {
  const proxy = loadProxySettings();
  const proxyActive = Boolean(proxy.enabled && proxy.host && proxy.port);
  return proxyActive || proxy.directConnectAllowed;
}

function blockedStats(trackers: TrackerConfig[]): TrackerStats[] {
  const error = 'Connexion bloquee : active un proxy ou coche explicitement la connexion directe sans proxy.';
  return trackers
    .filter(t => t.enabled !== false)
    .map(tracker => ({
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'error',
      error,
      lastUpdated: new Date().toISOString(),
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields:      {},
    }));
}

// Compteur de OK consecutifs par tracker (en memoire) pour l'auto-lever d'incident.
// Reset au redemarrage = conservateur (on garde l'incident plus longtemps), ce qui est voulu.
const incidentOkStreaks = new Map<string, number>();
const INCIDENT_AUTO_CLEAR_AFTER = 2; // nb de fetchs OK consecutifs avant auto-lever

interface RetryState {
  attempts: number;
  nextRunAt: number;
}

const retryStates = new Map<string, RetryState>();
const RETRY_DELAYS_MS = [
  10 * 60_000,
  10 * 60_000,
  10 * 60_000,
  60 * 60_000,
  60 * 60_000,
  60 * 60_000,
];

/**
 * Effet de bord : gere le compteur de OK consecutifs et leve l'incident apres
 * INCIDENT_AUTO_CLEAR_AFTER fetchs OK d'affilee. Toute erreur remet le compteur a zero.
 * A appeler EXACTEMENT UNE FOIS par tracker et par cycle de refresh (sinon le compteur
 * monte trop vite et leve un incident sur un seul vrai OK).
 */
function processIncidentStreak(stat: TrackerStats): void {
  const incident = getIncident(stat.id);
  if (!incident) {
    incidentOkStreaks.delete(stat.id);
    return;
  }
  if (stat.status === 'ok') {
    const streak = (incidentOkStreaks.get(stat.id) ?? 0) + 1;
    if (streak >= INCIDENT_AUTO_CLEAR_AFTER) {
      clearIncident(stat.id);
      incidentOkStreaks.delete(stat.id);
      console.log(`[Incident] ${stat.name} : ${INCIDENT_AUTO_CLEAR_AFTER} OK consecutifs -> incident leve automatiquement`);
    } else {
      incidentOkStreaks.set(stat.id, streak);
    }
  } else {
    // Une erreur casse la serie : on repart de zero
    incidentOkStreaks.delete(stat.id);
  }
}

/**
 * Pur (aucun effet de bord) : attache l'incident a la stat pour l'affichage.
 * Sur une stat OK, on n'attache rien (la carte verte n'affiche pas de badge incident).
 */
function attachIncident(stat: TrackerStats): TrackerStats {
  if (stat.status === 'ok' && !stat.stale) return stat;
  const incident = getIncident(stat.id);
  if (!incident) return stat;
  return { ...stat, incident: { acknowledged: incident.acknowledged, note: incident.note } };
}

function isTimeoutStat(stat: TrackerStats): boolean {
  const error = stat.error?.toLowerCase() ?? '';
  return error.includes('timeout') || error.includes('timed out') || error.includes('45000ms');
}

function latestKnownOkStat(tracker: TrackerConfig): TrackerStats | null {
  const cached = cachedStats.find(stat => stat.id === tracker.id && stat.status === 'ok' && !stat.stale);
  if (cached) return { ...cached, stale: undefined, incident: undefined };
  return getLatestOkStatSnapshot(tracker);
}

function preserveLastKnownOnTimeout(tracker: TrackerConfig, stat: TrackerStats): TrackerStats {
  if (stat.status !== 'error' || !isTimeoutStat(stat)) return stat;
  const incident = getIncident(stat.id);
  if (incident?.acknowledged) return stat;
  const previous = latestKnownOkStat(tracker);
  if (!previous) return stat;
  return {
    ...previous,
    name: tracker.name,
    trackerUrl: tracker.baseUrl,
    byteUnit: tracker.dashboard?.byteUnit ?? previous.byteUnit,
    stale: {
      reason: 'timeout',
      error: stat.error ?? 'Timeout lors du refresh',
      failedAt: stat.lastUpdated,
      siteReachability: stat.siteReachability,
    },
  };
}

function updateRetryState(tracker: TrackerConfig, fetched: TrackerStats, displayed: TrackerStats): void {
  if (fetched.status === 'ok') {
    retryStates.delete(tracker.id);
    return;
  }

  const incident = getIncident(tracker.id);
  if (incident?.acknowledged || !displayed.stale) {
    retryStates.delete(tracker.id);
    return;
  }

  const current = retryStates.get(tracker.id);
  const attempts = current ? current.attempts + 1 : 0;
  if (attempts >= RETRY_DELAYS_MS.length) {
    retryStates.delete(tracker.id);
    return;
  }

  retryStates.set(tracker.id, {
    attempts,
    nextRunAt: Date.now() + RETRY_DELAYS_MS[attempts],
  });
}

function upsertCachedStat(stat: TrackerStats): void {
  const annotated = attachIncident(stat);
  cachedStats = [
    ...cachedStats.filter(existing => existing.id !== annotated.id),
    annotated,
  ];
  lastRefresh = new Date().toISOString();
}

// Applique l'ordre de tuiles personnalise par l'utilisateur (drag & drop sur le
// dashboard). Les trackers absents de l'ordre enregistre conservent leur position
// relative et sont places apres ceux presents dans l'ordre.
function applyTrackerOrder(stats: TrackerStats[]): TrackerStats[] {
  const order = getJsonSetting<string[]>(TRACKER_ORDER_KEY, []);
  if (!order.length) return stats;
  const rank = new Map(order.map((id, i) => [id, i]));
  return stats
    .map((stat, index) => ({ stat, index }))
    .sort((a, b) => {
      const ra = rank.get(a.stat.id);
      const rb = rank.get(b.stat.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ stat }) => stat);
}

function visibleStats(trackers: TrackerConfig[]): TrackerStats[] {
  const cached = new Map(cachedStats.map(stat => [stat.id, stat]));
  const savedOrder = getJsonSetting(TRACKER_ORDER_KEY, { ids: [] as string[] });
  const order = new Map(
    (Array.isArray(savedOrder.ids) ? savedOrder.ids : [])
      .filter((id): id is string => typeof id === 'string')
      .map((id, index) => [id, index]),
  );

  return trackers
    .filter(tracker => tracker.enabled !== false)
    .map<TrackerStats>(tracker => cached.get(tracker.id) ?? ({
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'error',
      error:       'En attente du premier rafraichissement',
      lastUpdated: new Date().toISOString(),
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields:      {},
    }))
    .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

function logStatResult(stat: TrackerStats): void {
  if (stat.stale) {
    console.log(`  [${stat.name}] Stats anciennes conservees - ${stat.stale.error}`);
    return;
  }
  if (stat.status === 'ok') {
    const fields = Object.entries(stat.fields)
      .filter(([, value]) => value !== '' && value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${value}`);
    console.log(`  [${stat.name}] Stats OK${fields.length ? ` (${fields.join(', ')})` : ' (aucune donnee extraite)'}`);
    return;
  }

  if (stat.error?.startsWith('Credentials manquants')) return;
  console.log(`  [${stat.name}] Stats ERREUR - ${stat.error ?? 'Erreur inconnue'}`);
}

function isPresentationMode(): boolean {
  return Boolean(getJsonSetting(PRESENTATION_MODE_KEY, { enabled: false }).enabled);
}

function fakeNumber(seed: number, min: number, max: number): number {
  const value = Math.sin(seed * 9301 + 49297) * 233280;
  const normalized = value - Math.floor(value);
  return min + normalized * (max - min);
}

function fakeStatsForPresentation(): TrackerStats[] {
  const now = new Date();
  const ratiolessIds = new Set(['hdonly', 'nostradamus', 'nexum']);
  return listTrackerDefinitionFiles()
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
    .map((tracker, index) => {
      const uploadedBytes = Math.round(fakeNumber(index + 1, 80, 8200) * 1024 ** 3);
      const ratio = Number(fakeNumber(index + 7, 1.35, 38).toFixed(2));
      const downloadedBytes = Math.max(1, Math.round(uploadedBytes / ratio));
      const bufferBytes = uploadedBytes - downloadedBytes;
      const lastLoginAt = new Date(now.getTime() - fakeNumber(index + 11, 1, 96) * 3600_000).toISOString();
      const isRatioless = ratiolessIds.has(tracker.id);

      const fields: Record<string, string | number> = {
        uploadedBytes,
        downloadedBytes,
        ratio,
        bufferBytes,
      };

      if (isRatioless) {
        fields.points = Math.round(fakeNumber(index + 17, 50, 5200));
        fields.rate = Number(fakeNumber(index + 23, 0, 320).toFixed(1));
      } else {
        fields.seeding = Math.round(fakeNumber(index + 17, 0, 42));
        fields.seedBonus = index % 4 === 1
          ? ''
          : Math.round(fakeNumber(index + 23, 250, 185000)).toLocaleString('fr-FR');
      }

      return {
        id: tracker.id,
        name: tracker.name,
        trackerUrl: tracker.baseUrl,
        status: 'ok',
        lastUpdated: now.toISOString(),
        lastLoginAt,
        byteUnit: 'binary',
        fields,
      };
    });
}

// Nombre de trackers rafraichis en parallele. Au-dela, le navigateur headless sature
// (chaque tracker en mode browser lance un Chromium). 3 = bon compromis vitesse/charge.
// Surchargeable via la variable d'env REFRESH_CONCURRENCY.
const REFRESH_CONCURRENCY = Math.max(1, Number(process.env.REFRESH_CONCURRENCY) || 3);

/**
 * Applique `fn` a tous les items avec au plus `limit` executions simultanees.
 * Preserve l'ordre des resultats. Ne rejette jamais (fn doit gerer ses erreurs).
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(pool);
  return results;
}

// Timeout dur par tracker : au-dela, on libere le slot de concurrence et on TUE le
// contexte Chromium bloque (sinon un seul tracker qui pendouille fige tout le refresh).
const TRACKER_FETCH_TIMEOUT_MS = Math.max(30_000, Number(process.env.TRACKER_FETCH_TIMEOUT_MS) || 90_000);

async function fetchTrackerBounded(
  tracker: TrackerConfig,
  creds: { username: string; password: string },
): Promise<TrackerStats> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TrackerStats>(resolve => {
    timer = setTimeout(() => {
      // Tuer le Chromium reste bloque pour liberer CPU/RAM immediatement
      closeBrowserSession(tracker.id).catch(() => {});
      invalidateSession(tracker.id);
      resolve({
        id:          tracker.id,
        name:        tracker.name,
        trackerUrl:  tracker.baseUrl,
        status:      'error',
        error:       `Delai depasse (${Math.round(TRACKER_FETCH_TIMEOUT_MS / 1000)}s) - fetch interrompu`,
        lastUpdated: new Date().toISOString(),
        byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
        fields:      {},
      });
    }, TRACKER_FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetchTracker(tracker, creds), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Fenetre de fraicheur au boot : en dessous, on ressert la base sans re-scraper.
const BOOT_FRESH_HOURS = Math.max(0, Number(process.env.BOOT_FRESH_HOURS) || 24);

/**
 * Au demarrage : remplit cachedStats avec le dernier snapshot OK de chaque tracker
 * (s'il a moins de BOOT_FRESH_HOURS). Renvoie la liste des trackers a rafraichir
 * (pas de snapshot, ou snapshot trop vieux). Si BOOT_FRESH_HOURS=0, tout est obsolete.
 */
function hydrateFromSnapshots(trackers: TrackerConfig[]): TrackerConfig[] {
  if (isPresentationMode()) return []; // mode demo : pas d'hydratation, donnees factices
  const now = Date.now();
  const freshMs = BOOT_FRESH_HOURS * 3600_000;
  const hydrated: TrackerStats[] = [];
  const stale: TrackerConfig[] = [];
  for (const tracker of trackers) {
    if (tracker.enabled === false) continue;
    const snap = freshMs > 0 ? getLatestOkStatSnapshot(tracker) : null;
    const age = snap ? now - Date.parse(snap.lastUpdated) : Infinity;
    if (snap && Number.isFinite(age) && age < freshMs) {
      hydrated.push(attachIncident(snap));
    } else {
      stale.push(tracker);
    }
  }
  if (hydrated.length > 0) {
    cachedStats = hydrated;
    lastRefresh = new Date().toISOString();
  }
  return stale;
}

async function refresh(trackers: TrackerConfig[]): Promise<TrackerStats[]> {
  if (isRefreshing) return [];
  isRefreshing = true;
  console.log(`\n[${new Date().toISOString()}] Refresh...`);
  try {
    if (isPresentationMode()) {
      cachedStats = fakeStatsForPresentation();
      lastRefresh = new Date().toISOString();
      console.log('  Mode presentation actif - donnees factices');
      return cachedStats;
    }

    if (!proxyAllowsTrackerConnections()) {
      cachedStats = blockedStats(trackers);
      lastRefresh = new Date().toISOString();
      console.warn('  Connexions trackers bloquees : proxy absent et connexion directe non autorisee');
      return cachedStats;
    }

    const credentials = loadCredentialsFromDb();
    const enabledTrackers = trackers.filter(t => t.enabled !== false);
    const results = await mapWithConcurrency(enabledTrackers, REFRESH_CONCURRENCY, async tracker => {
      const creds = credentials[tracker.id];
      if (!creds) {
        const stat: TrackerStats = {
          id:          tracker.id,
          name:        tracker.name,
          trackerUrl:  tracker.baseUrl,
          status:      'error',
          error:       `Credentials manquants pour "${tracker.id}"`,
          lastUpdated: new Date().toISOString(),
          byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
          fields:      {},
        };
        upsertCachedStat(stat);
        logStatResult(stat);
        return stat;
      }

      const fetched = await fetchTrackerBounded(tracker, creds);
      processIncidentStreak(fetched); // une fois par tracker par cycle
      const stat = preserveLastKnownOnTimeout(tracker, fetched);
      updateRetryState(tracker, fetched, stat);
      upsertCachedStat(stat);
      logStatResult(stat);
      return stat;
    });
    // Fusion (pas de remplacement global) : on garde en cache les trackers NON
    // rafraichis dans ce cycle (ex: hydrates depuis la base au boot) et on remplace
    // uniquement ceux qu'on vient de refetcher. Permet refresh(sous-ensemble).
    const refreshedIds = new Set(results.map(r => r.id));
    cachedStats = [
      ...cachedStats.filter(s => !refreshedIds.has(s.id)),
      ...results.map(attachIncident),
    ];
    lastRefresh = new Date().toISOString();
    saveStatSnapshots(results.filter(stat => !stat.stale));
    const ok  = results.filter(s => s.status === 'ok').length;
    const err = results.filter(s => s.status === 'error').length;
    console.log(`  ✅ ${ok} ok  ❌ ${err} erreur(s)`);
    results.filter(s => s.status === 'error' && !s.error?.startsWith('Credentials manquants'))
      .forEach(s => console.log(`  ⚠️  ${s.name}: ${s.error}`));
    return results;
  } finally {
    isRefreshing = false;
  }
}

async function refreshOneTracker(
  tracker: TrackerConfig,
): Promise<TrackerStats> {
  if (isPresentationMode()) {
    const stat = fakeStatsForPresentation().find(item => item.id === tracker.id);
    if (stat) return stat;
  }

  if (!proxyAllowsTrackerConnections()) {
    const stat = blockedStats([tracker])[0];
    upsertCachedStat(stat);
    logStatResult(stat);
    return stat;
  }

  const creds = loadCredentialsFromDb()[tracker.id];
  if (!creds) {
    const stat: TrackerStats = {
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'error',
      error:       `Credentials manquants pour "${tracker.id}"`,
      lastUpdated: new Date().toISOString(),
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields:      {},
    };
    upsertCachedStat(stat);
    logStatResult(stat);
    return stat;
  }

  const fetched = await fetchTrackerBounded(tracker, creds);
  processIncidentStreak(fetched); // une fois par tracker par cycle
  const stat = preserveLastKnownOnTimeout(tracker, fetched);
  updateRetryState(tracker, fetched, stat);
  upsertCachedStat(stat);
  logStatResult(stat);
  if (!stat.stale) saveStatSnapshots([stat]);
  return stat;
}


// ─── Serveur ──────────────────────────────────────────────────────────────────

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randomSpacingMs(): number {
  return (10 + Math.floor(Math.random() * 81)) * 1000;
}

async function refreshScheduledTracker(
  tracker: TrackerConfig,
): Promise<void> {
  if (isRefreshing) return;
  if (!proxyAllowsTrackerConnections()) {
    console.warn(`  [${tracker.name}] Refresh planifie bloque : proxy absent et connexion directe non autorisee`);
    return;
  }

  const creds = loadCredentialsFromDb()[tracker.id];
  if (!creds) {
    console.warn(`  [${tracker.name}] Refresh planifie ignore : credentials manquants`);
    return;
  }

  const fetched = await fetchTrackerBounded(tracker, creds);
  processIncidentStreak(fetched);
  const stat = preserveLastKnownOnTimeout(tracker, fetched);
  updateRetryState(tracker, fetched, stat);
  upsertCachedStat(stat);
  logStatResult(stat);
  if (!stat.stale) saveStatSnapshots([stat]);
}

function nextBetaScheduleRun(schedule: BetaScheduleSettings, from = new Date()): string | null {
  if (!schedule.enabled) return null;
  const next = new Date(from);
  next.setSeconds(0, 0);

  if (schedule.mode === 'hours') {
    next.setTime(from.getTime() + schedule.intervalHours * 3600_000);
    return next.toISOString();
  }

  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (schedule.mode === 'days') {
    if (next <= from) next.setDate(next.getDate() + schedule.intervalDays);
    return next.toISOString();
  }

  const weekdays = new Set(schedule.weekdays);
  if (weekdays.size === 0) return null;
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(next);
    candidate.setDate(next.getDate() + offset);
    if (weekdays.has(candidate.getDay()) && candidate > from) return candidate.toISOString();
  }
  return null;
}

async function notifyScheduledResult(
  settings: BetaSettings,
  results: TrackerStats[],
  previousFailures: Set<string>,
): Promise<void> {
  const targets = settings.notificationTargets.filter(target => target.enabled && target.url);
  if (targets.length === 0 || results.length === 0) return;

  const errors = results.filter(result => result.status === 'error');
  const recovered = results.filter(result => result.status === 'ok' && previousFailures.has(result.id));
  const prefs = settings.notificationPreferences;
  let title = '';
  let lines: string[] = [];

  if (errors.length > 0 && prefs.notifyError) {
    title = `Tracker Dashboard : ${errors.length} echec(s)`;
    lines = errors.map(result => `${result.name}: ${result.error || 'erreur inconnue'}`);
  } else if (recovered.length > 0 && prefs.notifySuccessAfterFailure) {
    title = 'Tracker Dashboard : retablissement';
    lines = [`Sites retablis : ${recovered.map(result => result.name).join(', ')}`];
  } else if (errors.length === 0 && prefs.notifySuccess) {
    title = 'Tracker Dashboard : cycle termine';
    lines = ['Tous les trackers configures sont accessibles.'];
    if (prefs.notifyStats) {
      lines.push(...results.map(result => `${result.name}: ${Object.entries(result.fields ?? {}).slice(0, 4).map(([key, value]) => `${key}=${String(value)}`).join(', ') || 'OK'}`));
    }
  }

  if (!title) return;
  const deliveries = await Promise.allSettled(targets.map(target => sendBetaNotification(target, lines.join('\n'), title)));
  deliveries.forEach((delivery, index) => {
    if (delivery.status === 'rejected') {
      console.error(`[Beta Notifications] ${targets[index].label}:`, delivery.reason);
    }
  });
}

async function runBetaScheduledCycle(): Promise<void> {
  if (isRefreshing || pendingScheduledRuns.has('__global__')) return;
  const settings = loadBetaSettings();
  if (!settings.schedule.enabled) return;

  const credentials = loadCredentialsFromDb();
  const overridden = new Set(settings.scheduleOverrides.map(override => override.trackerId));
  const trackers = loadTrackerConfigsFromDb().filter(tracker => (
    tracker.enabled !== false && credentials[tracker.id] && !overridden.has(tracker.id)
  ));
  const previousFailures = new Set(settings.schedule.lastFailedTrackerIds);
  pendingScheduledRuns.add('__global__');
  try {
    const results = await refresh(trackers);
    await notifyScheduledResult(settings, results, previousFailures);
    settings.schedule.lastFailedTrackerIds = results.filter(result => result.status === 'error').map(result => result.id);
  } finally {
    const current = loadBetaSettings();
    current.schedule.lastRunAt = new Date().toISOString();
    current.schedule.nextRunAt = nextBetaScheduleRun(current.schedule);
    current.schedule.lastFailedTrackerIds = settings.schedule.lastFailedTrackerIds;
    setJsonSetting(BETA_SETTINGS_KEY, current);
    pendingScheduledRuns.delete('__global__');
  }
}

async function runBetaTrackerSchedule(override: BetaTrackerScheduleOverride): Promise<void> {
  if (isRefreshing || pendingScheduledRuns.has(override.trackerId)) return;
  const settings = loadBetaSettings();
  const tracker = loadTrackerConfigsFromDb().find(item => item.id === override.trackerId && item.enabled !== false);
  if (!tracker || !loadCredentialsFromDb()[tracker.id]) return;
  const previousFailures = new Set(cachedStats.filter(stat => stat.status === 'error').map(stat => stat.id));
  pendingScheduledRuns.add(tracker.id);
  try {
    const result = await refreshOneTracker(tracker);
    await notifyScheduledResult(settings, [result], previousFailures);
  } finally {
    const current = loadBetaSettings();
    const saved = current.scheduleOverrides.find(item => item.trackerId === override.trackerId);
    if (saved?.mode === 'interval') {
      saved.lastRunAt = new Date().toISOString();
      saved.nextRunAt = new Date(Date.now() + saved.intervalHours * 3600_000).toISOString();
      setJsonSetting(BETA_SETTINGS_KEY, current);
    }
    pendingScheduledRuns.delete(tracker.id);
  }
}

function startScheduler(): void {
  const tick = () => {
    const settings = loadBetaSettings();
    if (settings.schedule.enabled) {
      if (!settings.schedule.nextRunAt) {
        settings.schedule.nextRunAt = nextBetaScheduleRun(settings.schedule);
        setJsonSetting(BETA_SETTINGS_KEY, settings);
      } else if (Date.parse(settings.schedule.nextRunAt) <= Date.now()) {
        void runBetaScheduledCycle().catch(err => console.error('[Beta Scheduler] cycle en erreur :', err));
      }
    }

    for (const override of settings.scheduleOverrides) {
      if (override.mode === 'interval' && override.nextRunAt && Date.parse(override.nextRunAt) <= Date.now()) {
        void runBetaTrackerSchedule(override).catch(err => {
          console.error(`[Beta Scheduler] ${override.trackerId} en erreur :`, err);
        });
      }
    }

    // Rafraîchissement automatique des clients BitTorrent, par client et selon
    // l'intervalle configuré (refreshMinutes). Granularité = ce tick (60 s).
    const nowQbit = Date.now();
    for (const client of settings.qbitClients) {
      if (!client.enabled) continue;
      const minutes = Math.floor(Number(client.refreshMinutes) || 0);
      if (minutes < 1) continue;
      const last = qbitClientLastScan.get(client.id) ?? 0;
      if (nowQbit - last < minutes * 60_000) continue;
      // Marquer l'échéance immédiatement pour éviter un double déclenchement
      // pendant que le scan (asynchrone) est en cours.
      qbitClientLastScan.set(client.id, nowQbit);
      void refreshSingleQbitClient(client);
    }

    const trackers = loadTrackerConfigsFromDb();
    const now = Date.now();
    let delay = 0;
    const retries = [...retryStates.entries()].filter(([, state]) => state.nextRunAt <= now);
    for (const [trackerId] of shuffled(retries)) {
      if (pendingScheduledRuns.has(trackerId)) continue;
      if (getIncident(trackerId)?.acknowledged) {
        retryStates.delete(trackerId);
        continue;
      }
      const tracker = trackers.find(item => item.id === trackerId && item.enabled !== false);
      if (!tracker) continue;
      pendingScheduledRuns.add(trackerId);
      delay += randomSpacingMs();
      setTimeout(() => {
        refreshScheduledTracker(tracker)
          .catch(err => console.error(`[${tracker.name}] Retry timeout en erreur :`, err))
          .finally(() => pendingScheduledRuns.delete(trackerId));
      }, delay);
    }
  };

  tick();
  setInterval(tick, 60_000);
}

// ─── Prometheus metrics ───────────────────────────────────────────────────────

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = parseFloat(value.replace(/[\s ]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function renderPrometheusMetrics(stats: TrackerStats[]): string {
  const definitions: Array<{ name: string; help: string; type: 'gauge' | 'counter'; pick: (s: TrackerStats) => number | null }> = [
    { name: 'tracker_uploaded_bytes_total',   help: 'Cumulative uploaded bytes', type: 'counter', pick: s => toNumber(s.fields.uploadedBytes) },
    { name: 'tracker_downloaded_bytes_total', help: 'Cumulative downloaded bytes', type: 'counter', pick: s => toNumber(s.fields.downloadedBytes) },
    { name: 'tracker_ratio',            help: 'Ratio (scraped or computed up/down)', type: 'gauge', pick: s => {
        const r = toNumber(s.fields.ratio);
        if (r !== null) return r;
        const up = toNumber(s.fields.uploadedBytes);
        const down = toNumber(s.fields.downloadedBytes);
        if (up === null || down === null) return null;
        if (down === 0) return up > 0 ? Number.POSITIVE_INFINITY : 0;
        return up / down;
      } },
    { name: 'tracker_buffer_bytes', help: 'Buffer = uploaded - downloaded (scraped if present)', type: 'gauge', pick: s => {
        const b = toNumber(s.fields.bufferBytes);
        if (b !== null) return b;
        const up = toNumber(s.fields.uploadedBytes);
        const down = toNumber(s.fields.downloadedBytes);
        if (up === null || down === null) return null;
        return up - down;
      } },
    { name: 'tracker_seed_bonus',     help: 'Bonus points', type: 'gauge', pick: s => toNumber(s.fields.seedBonus) },
    { name: 'tracker_seed_time_days', help: 'Average seed time in days', type: 'gauge', pick: s => toNumber(s.fields.seedTimeDays) },
    { name: 'tracker_seeding_count',  help: 'Active seeding torrents', type: 'gauge', pick: s => toNumber(s.fields.seeding) },
    { name: 'tracker_leeching_count', help: 'Active leeching torrents', type: 'gauge', pick: s => toNumber(s.fields.leeching) },
    { name: 'tracker_points',         help: 'Points (ratioless trackers)', type: 'gauge', pick: s => toNumber(s.fields.points) },
    { name: 'tracker_rate_per_day',   help: 'Points earned per day (ratioless)', type: 'gauge', pick: s => toNumber(s.fields.rate) },
    { name: 'tracker_tokens',         help: 'Freeleech tokens', type: 'gauge', pick: s => toNumber(s.fields.tokens) },
    { name: 'tracker_up',             help: '1 if last fetch succeeded, 0 if error', type: 'gauge', pick: s => s.status === 'ok' && !s.stale ? 1 : 0 },
    { name: 'tracker_site_reachable', help: '1 if last ping succeeded, 0 if failed, absent if not measured', type: 'gauge', pick: s => {
        const reachability = s.stale?.siteReachability ?? s.siteReachability;
        return reachability ? (reachability.reachable ? 1 : 0) : null;
      } },
    { name: 'tracker_last_update_timestamp_seconds', help: 'Unix timestamp of last refresh', type: 'gauge', pick: s => {
        const t = Date.parse(s.lastUpdated);
        return Number.isFinite(t) ? Math.floor(t / 1000) : null;
      } },
  ];

  const lines: string[] = [];
  for (const def of definitions) {
    lines.push(`# HELP ${def.name} ${def.help}`);
    lines.push(`# TYPE ${def.name} ${def.type}`);
    for (const stat of stats) {
      const value = def.pick(stat);
      if (value === null) continue;
      const labels = `tracker="${escapeLabel(stat.id)}",name="${escapeLabel(stat.name)}"`;
      const printable = Number.isFinite(value) ? value : (value > 0 ? '+Inf' : '-Inf');
      lines.push(`${def.name}{${labels}} ${printable}`);
    }
  }
  if (betaQbitStats.length > 0) {
    const qbitDefinitions: Array<{ name: string; help: string; type: 'gauge' | 'counter'; pick: (s: QbitTrackerAggregate) => number | null }> = [
      { name: 'tracker_qbit_torrents', help: 'qBittorrent torrents grouped by tracker host', type: 'gauge', pick: s => s.torrentCount },
      { name: 'tracker_qbit_seeding_torrents', help: 'qBittorrent seeding torrents grouped by tracker host', type: 'gauge', pick: s => s.seedingCount },
      { name: 'tracker_qbit_leeching_torrents', help: 'qBittorrent leeching torrents grouped by tracker host', type: 'gauge', pick: s => s.leechingCount },
      { name: 'tracker_qbit_uploaded_bytes_total', help: 'qBittorrent uploaded bytes grouped by tracker host', type: 'counter', pick: s => s.uploadedBytes },
      { name: 'tracker_qbit_downloaded_bytes_total', help: 'qBittorrent downloaded bytes grouped by tracker host', type: 'counter', pick: s => s.downloadedBytes },
      { name: 'tracker_qbit_ratio', help: 'qBittorrent ratio grouped by tracker host', type: 'gauge', pick: s => s.ratio },
      { name: 'tracker_qbit_shared_size_bytes', help: 'qBittorrent total torrent size grouped by tracker host', type: 'gauge', pick: s => s.totalSizeBytes },
    ];
    for (const def of qbitDefinitions) {
      lines.push(`# HELP ${def.name} ${def.help}`);
      lines.push(`# TYPE ${def.name} ${def.type}`);
      for (const stat of betaQbitStats) {
        const value = def.pick(stat);
        if (value === null) continue;
        const labels = `client="${escapeLabel(stat.clientId)}",client_name="${escapeLabel(stat.clientLabel)}",tracker_host="${escapeLabel(stat.trackerHost)}"`;
        lines.push(`${def.name}{${labels}} ${value}`);
      }
    }
    if (betaQbitLastRefresh) {
      const t = Date.parse(betaQbitLastRefresh);
      if (Number.isFinite(t)) {
        lines.push('# HELP tracker_qbit_last_refresh_timestamp_seconds Unix timestamp of last qBittorrent beta refresh');
        lines.push('# TYPE tracker_qbit_last_refresh_timestamp_seconds gauge');
        lines.push(`tracker_qbit_last_refresh_timestamp_seconds ${Math.floor(t / 1000)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function defaultBetaSettings(): BetaSettings {
  return {
    qbitClients: [],
    announceMappings: [],
    notificationTargets: [],
    scheduleOverrides: [],
    schedule: {
      enabled: false,
      mode: 'days',
      intervalHours: 6,
      intervalDays: 1,
      hour: 3,
      minute: 0,
      weekdays: [],
      nextRunAt: null,
      lastRunAt: null,
      lastFailedTrackerIds: [],
    },
    notificationPreferences: {
      notifyError: true,
      notifySuccess: false,
      notifySuccessAfterFailure: true,
      notifyStats: false,
    },
    alertRules: [],
    defaults: {
      ratioEnabled: true,
      ratioThreshold: 1,
      cookieDays: 7,
      siteDownEnabled: true,
    },
  };
}

function loadBetaSettings(): BetaSettings {
  const settings = getJsonSetting(BETA_SETTINGS_KEY, defaultBetaSettings());
  return {
    ...defaultBetaSettings(),
    ...settings,
    defaults: { ...defaultBetaSettings().defaults, ...(settings.defaults ?? {}) },
    qbitClients: Array.isArray(settings.qbitClients) ? settings.qbitClients : [],
    announceMappings: Array.isArray(settings.announceMappings) ? settings.announceMappings : [],
    notificationTargets: Array.isArray(settings.notificationTargets) ? settings.notificationTargets : [],
    scheduleOverrides: Array.isArray(settings.scheduleOverrides) ? settings.scheduleOverrides : [],
    schedule: { ...defaultBetaSettings().schedule, ...(settings.schedule ?? {}) },
    notificationPreferences: {
      ...defaultBetaSettings().notificationPreferences,
      ...(settings.notificationPreferences ?? {}),
    },
    alertRules: Array.isArray(settings.alertRules) ? settings.alertRules : [],
  };
}

function sanitizeBetaSettings(settings: BetaSettings): BetaSettings {
  return {
    ...settings,
    qbitClients: settings.qbitClients.map(client => ({
      ...client,
      password: client.password ? '••••••••' : '',
    })),
    announceMappings: settings.announceMappings,
    notificationTargets: settings.notificationTargets.map(target => ({
      ...target,
      urls: target.urls?.map(() => '********'),
      url: target.url ? '••••••••' : '',
    })),
  };
}

function saveBetaSettingsPayload(raw: unknown): BetaSettings {
  const current = loadBetaSettings();
  const body = (raw && typeof raw === 'object' ? raw : {}) as Partial<BetaSettings>;
  const previousClients = new Map(current.qbitClients.map(client => [client.id, client]));
  const previousTargets = new Map(current.notificationTargets.map(target => [target.id, target]));

  const qbitClients: BetaQbitClient[] = Array.isArray(body.qbitClients) ? body.qbitClients.map(rawClient => {
    const client = rawClient as Partial<BetaQbitClient>;
    const id = typeof client.id === 'string' && client.id ? client.id : crypto.randomUUID();
    const previous = previousClients.get(id);
    const password = client.password === '••••••••' ? (previous?.password ?? '') : (client.password ?? '');
    const type: BetaQbitClient['type'] = client.type === 'rutorrent' ? 'rutorrent' : 'qbittorrent';
    return {
      id,
      type,
      label: String(client.label || (type === 'rutorrent' ? 'ruTorrent' : 'qBittorrent')).trim().slice(0, 80),
      baseUrl: cleanClientBaseUrl(String(client.baseUrl || '')),
      username: String(client.username || '').trim(),
      password,
      enabled: client.enabled !== false,
      refreshMinutes: Math.max(0, Math.min(43200, Math.floor(Number(client.refreshMinutes) || 0))),
    };
  }).filter(client => client.baseUrl) : current.qbitClients;

  const notificationTargets: BetaNotificationTarget[] = Array.isArray(body.notificationTargets) ? body.notificationTargets.map(rawTarget => {
    const target = rawTarget as Partial<BetaNotificationTarget>;
    const id = typeof target.id === 'string' && target.id ? target.id : crypto.randomUUID();
    const previous = previousTargets.get(id);
    const url = target.url === '••••••••' ? (previous?.url ?? '') : (target.url ?? '');
    const type: BetaNotificationTarget['type'] = target.type === 'apprise' ? 'apprise' : 'discord';
    return {
      id,
      type,
      label: String(target.label || (type === 'discord' ? 'Discord' : 'Apprise')).trim().slice(0, 80),
      url: String(url || '').trim(),
      urls: Array.isArray(target.urls)
        ? (target.urls.every(value => value === '********')
          ? (previous?.urls ?? [])
          : target.urls.map(value => String(value).trim()).filter(Boolean))
        : (previous?.urls ?? []),
      enabled: target.enabled !== false,
    };
  }).filter(target => target.url) : current.notificationTargets;

  const announceMappings: BetaAnnounceMapping[] = Array.isArray(body.announceMappings) ? body.announceMappings.map(rawMapping => {
    const mapping = rawMapping as Partial<BetaAnnounceMapping>;
    return {
      announceHost: trackerHost(mapping.announceHost),
      trackerId: String(mapping.trackerId || '').trim(),
    };
  }).filter(mapping => mapping.announceHost && mapping.announceHost !== 'unknown' && mapping.trackerId) : current.announceMappings;

  const alertRules = Array.isArray(body.alertRules) ? body.alertRules.map(rawRule => {
    const rule = rawRule as Partial<BetaAlertRule>;
    return {
      id: typeof rule.id === 'string' && rule.id ? rule.id : crypto.randomUUID(),
      trackerId: String(rule.trackerId || '').trim(),
      enabled: rule.enabled !== false,
      kind: ['buffer', 'seedtime', 'cookie', 'site'].includes(String(rule.kind)) ? rule.kind as BetaAlertRule['kind'] : 'ratio',
      operator: ['<=', '<', '>=', '>', 'expired', 'soon', 'down'].includes(String(rule.operator)) ? rule.operator as BetaAlertRule['operator'] : '<=',
      threshold: Number.isFinite(Number(rule.threshold)) ? Number(rule.threshold) : 1,
      targetIds: Array.isArray(rule.targetIds) ? rule.targetIds.filter((id): id is string => typeof id === 'string') : [],
    };
  }).filter(rule => rule.trackerId) : current.alertRules;

  const defaults = {
    ...current.defaults,
    ...(body.defaults ?? {}),
    ratioThreshold: Number.isFinite(Number(body.defaults?.ratioThreshold)) ? Number(body.defaults?.ratioThreshold) : current.defaults.ratioThreshold,
    cookieDays: Number.isFinite(Number(body.defaults?.cookieDays)) ? Number(body.defaults?.cookieDays) : current.defaults.cookieDays,
    ratioEnabled: body.defaults?.ratioEnabled !== false,
    siteDownEnabled: body.defaults?.siteDownEnabled !== false,
  };

  const rawSchedule = body.schedule ?? current.schedule;
  const mode: BetaScheduleSettings['mode'] = ['hours', 'weekdays'].includes(String(rawSchedule.mode))
    ? rawSchedule.mode as BetaScheduleSettings['mode']
    : 'days';
  const schedule: BetaScheduleSettings = {
    enabled: rawSchedule.enabled === true,
    mode,
    intervalHours: Math.min(168, Math.max(1, Number(rawSchedule.intervalHours) || 6)),
    intervalDays: Math.min(30, Math.max(1, Number(rawSchedule.intervalDays) || 1)),
    hour: Math.min(23, Math.max(0, Number(rawSchedule.hour) || 0)),
    minute: Math.min(59, Math.max(0, Number(rawSchedule.minute) || 0)),
    weekdays: Array.isArray(rawSchedule.weekdays)
      ? [...new Set(rawSchedule.weekdays.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))]
      : [],
    nextRunAt: current.schedule.nextRunAt,
    lastRunAt: current.schedule.lastRunAt,
    lastFailedTrackerIds: Array.isArray(current.schedule.lastFailedTrackerIds)
      ? current.schedule.lastFailedTrackerIds
      : [],
  };
  const scheduleChanged = schedule.enabled !== current.schedule.enabled
    || schedule.mode !== current.schedule.mode
    || schedule.intervalHours !== current.schedule.intervalHours
    || schedule.intervalDays !== current.schedule.intervalDays
    || schedule.hour !== current.schedule.hour
    || schedule.minute !== current.schedule.minute
    || schedule.weekdays.join(',') !== current.schedule.weekdays.join(',');
  if (scheduleChanged || (schedule.enabled && !schedule.nextRunAt)) {
    schedule.nextRunAt = nextBetaScheduleRun(schedule);
  }
  if (!schedule.enabled) schedule.nextRunAt = null;

  const previousOverrides = new Map(current.scheduleOverrides.map(override => [override.trackerId, override]));
  const scheduleOverrides: BetaTrackerScheduleOverride[] = Array.isArray(body.scheduleOverrides)
    ? body.scheduleOverrides.map(rawOverride => {
      const override = rawOverride as Partial<BetaTrackerScheduleOverride>;
      const trackerId = String(override.trackerId || '').trim();
      const previous = previousOverrides.get(trackerId);
      const overrideMode: BetaTrackerScheduleOverride['mode'] = ['disabled', 'interval'].includes(String(override.mode))
        ? override.mode as BetaTrackerScheduleOverride['mode']
        : 'global';
      const intervalHours = [6, 12, 24, 48, 168, 504].includes(Number(override.intervalHours))
        ? Number(override.intervalHours)
        : 24;
      const changed = !previous || previous.mode !== overrideMode || previous.intervalHours !== intervalHours;
      return {
        trackerId,
        mode: overrideMode,
        intervalHours,
        nextRunAt: overrideMode === 'interval'
          ? (changed || !previous?.nextRunAt ? new Date(Date.now() + intervalHours * 3600_000).toISOString() : previous.nextRunAt)
          : null,
        lastRunAt: previous?.lastRunAt ?? null,
      };
    }).filter(override => override.trackerId && override.mode !== 'global')
    : current.scheduleOverrides;

  const rawPreferences = body.notificationPreferences ?? current.notificationPreferences;
  const notificationPreferences: BetaNotificationPreferences = {
    notifyError: rawPreferences.notifyError !== false,
    notifySuccess: rawPreferences.notifySuccess === true,
    notifySuccessAfterFailure: rawPreferences.notifySuccessAfterFailure !== false,
    notifyStats: rawPreferences.notifyStats === true,
  };

  const next = { qbitClients, announceMappings, notificationTargets, schedule, scheduleOverrides, notificationPreferences, alertRules, defaults };
  setJsonSetting(BETA_SETTINGS_KEY, next);
  return next;
}

function trackerHost(value: string | undefined): string {
  if (!value) return 'unknown';
  try {
    return new URL(value).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(value)
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .split('?')[0]
      .replace(/^www\./, '')
      .toLowerCase() || 'unknown';
  }
}

function hostDomainKey(host: string): string {
  const clean = trackerHost(host);
  if (clean === 'unknown') return clean;
  const parts = clean.split('.').filter(Boolean);
  return parts.length <= 2 ? clean : parts.slice(-2).join('.');
}

function matchTokens(value: string): string[] {
  return trackerHost(value)
    .split(/[^a-z0-9]+/i)
    .map(token => token.toLowerCase())
    .filter(token => token.length >= 3 && !['www', 'net', 'org', 'com', 'lol', 'cc'].includes(token));
}

function betaTrackerMatchScore(announceHost: string, tracker: TrackerConfig): number {
  const announce = trackerHost(announceHost);
  const base = trackerHost(tracker.baseUrl);
  if (announce === 'unknown' || base === 'unknown') return 0;
  let score = 0;
  if (announce === base) score += 120;
  if (hostDomainKey(announce) === hostDomainKey(base)) score += 90;
  if (announce.includes(base) || base.includes(announce)) score += 45;
  const announceTokens = new Set(matchTokens(announce));
  const trackerTokens = new Set([
    ...matchTokens(base),
    ...String(tracker.name || '').toLowerCase().split(/[^a-z0-9]+/i).filter(token => token.length >= 3),
    ...String(tracker.id || '').toLowerCase().split(/[^a-z0-9]+/i).filter(token => token.length >= 3),
  ]);
  for (const token of announceTokens) {
    if (trackerTokens.has(token)) score += 25;
  }
  return score;
}

function betaTrackerIdForAnnounceHost(announceHost: string, trackerHosts: Map<string, string>, activeTrackers: TrackerConfig[]): string | null {
  const host = trackerHost(announceHost);
  const direct = trackerHosts.get(host) ?? trackerHosts.get(hostDomainKey(host));
  if (direct) return direct;
  const best = activeTrackers
    .map(tracker => ({ tracker, score: betaTrackerMatchScore(host, tracker) }))
    .sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 45 ? best.tracker.id : null;
}

function betaClientLogName(client: BetaQbitClient): string {
  return `${client.label || client.id || 'Client BitTorrent'} (${client.type === 'rutorrent' ? 'ruTorrent/rTorrent' : 'qBittorrent'})`;
}

// Agrege le nombre de torrents en seed remonte par les clients BitTorrent, par trackerId, en
// sommant tous les clients (qBittorrent et/ou rTorrent). On collecte aussi l'ensemble des types
// de clients ayant contribue, pour l'etiquette (qBit / Rto / qBit Rto). On reutilise le meme
// matching host d'annonce -> tracker que l'onglet beta (mappings manuels + heuristique).
// Retourne une map vide si aucune synchro BitTorrent n'a encore tourne (betaQbitStats en memoire).
function qbitSeedingByTrackerId(trackers: TrackerConfig[]): Map<string, { count: number; types: Set<string> }> {
  const result = new Map<string, { count: number; types: Set<string> }>();
  if (betaQbitStats.length === 0) return result;
  const settings = loadBetaSettings();
  const clientType = new Map(settings.qbitClients.map(client => [client.id, client.type === 'rutorrent' ? 'rutorrent' : 'qbittorrent']));
  const trackerHosts = new Map<string, string>();
  for (const tracker of trackers) {
    const host = trackerHost(tracker.baseUrl);
    trackerHosts.set(host, tracker.id);
    trackerHosts.set(hostDomainKey(host), tracker.id);
  }
  for (const mapping of settings.announceMappings) {
    const host = trackerHost(mapping.announceHost);
    trackerHosts.set(host, mapping.trackerId);
    trackerHosts.set(hostDomainKey(host), mapping.trackerId);
  }
  for (const item of betaQbitStats) {
    const trackerId = betaTrackerIdForAnnounceHost(item.trackerHost, trackerHosts, trackers);
    if (!trackerId) continue;
    const entry = result.get(trackerId) ?? { count: 0, types: new Set<string>() };
    entry.count += item.seedingCount;
    const type = clientType.get(item.clientId);
    if (type) entry.types.add(type);
    result.set(trackerId, entry);
  }
  return result;
}

function betaLog(message: string): void {
  console.log(`[Beta BitTorrent] ${message}`);
}

function betaWarn(message: string): void {
  console.warn(`[Beta BitTorrent] ${message}`);
}

function redactedAnnounceForLog(value: string): string {
  const host = trackerHost(value);
  if (host === 'unknown') return 'unknown';
  try {
    const url = new URL(value);
    return `${url.protocol}//${host}${url.pathname ? url.pathname.replace(/\/[^/]{8,}(?=\/|$)/g, '/***') : ''}`;
  } catch {
    return host;
  }
}

function responsePreview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text || '').replace(/\s+/g, ' ').slice(0, 160);
}

function cleanClientBaseUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    const pathname = url.pathname.replace(/\/+$/, '');
    if (/\/api\/v2$/i.test(pathname)) url.pathname = pathname.replace(/\/api\/v2$/i, '') || '/';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw.replace(/[#?].*$/, '').replace(/\/api\/v2\/?$/i, '').replace(/\/+$/, '');
  }
}

function qbitHttpError(endpoint: string, status: number, data: unknown, authState: 'none' | 'attempted' | 'authenticated'): Error {
  const preview = responsePreview(data);
  const authHint = authState === 'authenticated'
    ? 'auth effectuee, verifier droits WebUI, Host header / reverse proxy ou IP bannie'
    : (authState === 'attempted'
      ? 'identifiants envoyes mais refuses par qBittorrent, verifier username/password WebUI ou IP bannie'
      : 'aucun identifiant envoye, renseigner utilisateur/mot de passe WebUI qBittorrent');
  return new Error(`qBittorrent ${endpoint} HTTP ${status}${preview ? ` - ${preview}` : ''} (${authHint})`);
}

async function fetchQbitClient(client: BetaQbitClient): Promise<QbitTrackerAggregate[]> {
  const jar: string[] = [];
  const baseUrl = cleanClientBaseUrl(client.baseUrl);
  const directRequest = { proxy: false as const };
  let authenticated = false;
  betaLog(`${betaClientLogName(client)}: scan qBittorrent sur ${baseUrl}`);
  if (!client.username && !client.password) {
    betaWarn(`${betaClientLogName(client)}: aucun identifiant qBittorrent configure; l'API peut repondre 403 meme si VueTorrent est connecte dans le navigateur`);
  }
  if (client.username || client.password) {
    betaLog(`${betaClientLogName(client)}: authentification qBittorrent`);
    const login = await axios.post(
      `${baseUrl}/api/v2/auth/login`,
      new URLSearchParams({ username: client.username ?? '', password: client.password ?? '' }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
        validateStatus: () => true,
        ...directRequest,
      },
    );
    const cookie = login.headers['set-cookie'];
    if (Array.isArray(cookie)) jar.push(...cookie.map(item => item.split(';')[0]));
    betaLog(`${betaClientLogName(client)}: auth HTTP ${login.status}, cookie(s) ${jar.length}, reponse "${String(login.data).trim().slice(0, 40)}"`);
    const loginBody = String(login.data || '').trim();
    const loginOk = (login.status === 200 && loginBody === 'Ok.') || (login.status === 204 && jar.length > 0);
    if (!loginOk) {
      throw qbitHttpError('/api/v2/auth/login', login.status, login.data, 'attempted');
    }
    authenticated = true;
  }

  try {
    const versionResponse = await axios.get(`${baseUrl}/api/v2/app/version`, {
      timeout: 6000,
      headers: jar.length ? { Cookie: jar.join('; ') } : undefined,
      validateStatus: () => true,
      ...directRequest,
    });
    betaLog(`${betaClientLogName(client)}: app/version HTTP ${versionResponse.status}, version "${responsePreview(versionResponse.data)}"`);
  } catch (err: unknown) {
    betaWarn(`${betaClientLogName(client)}: app/version KO - ${err instanceof Error ? err.message : String(err)}`);
  }

  const response = await axios.get(`${baseUrl}/api/v2/torrents/info`, {
    timeout: 12000,
    headers: jar.length ? { Cookie: jar.join('; ') } : undefined,
    params: { filter: 'all' },
    validateStatus: () => true,
    ...directRequest,
  });
  if (response.status >= 400) {
    throw qbitHttpError('/api/v2/torrents/info', response.status, response.data, authenticated ? 'authenticated' : 'none');
  }
  if (!Array.isArray(response.data)) {
    betaWarn(`${betaClientLogName(client)}: /torrents/info reponse non attendue: ${responsePreview(response.data)}`);
  }
  let torrents = Array.isArray(response.data) ? response.data as Array<Record<string, unknown>> : [];
  betaLog(`${betaClientLogName(client)}: /torrents/info HTTP ${response.status}, ${torrents.length} torrent(s), type reponse ${Array.isArray(response.data) ? 'array' : typeof response.data}`);
  if (!torrents.length) {
    try {
      betaLog(`${betaClientLogName(client)}: /torrents/info vide, essai fallback /sync/maindata`);
      const syncResponse = await axios.get(`${baseUrl}/api/v2/sync/maindata`, {
        timeout: 12000,
        headers: jar.length ? { Cookie: jar.join('; ') } : undefined,
        params: { rid: 0 },
        validateStatus: () => true,
        ...directRequest,
      });
      if (syncResponse.status >= 400) {
        betaWarn(`${betaClientLogName(client)}: /sync/maindata HTTP ${syncResponse.status}`);
      }
      const syncTorrents = (syncResponse.data as { torrents?: Record<string, Record<string, unknown>> })?.torrents;
      if (!syncTorrents || typeof syncTorrents !== 'object') {
        betaWarn(`${betaClientLogName(client)}: /sync/maindata sans objet torrents, apercu: ${responsePreview(syncResponse.data)}`);
      }
      torrents = syncTorrents && typeof syncTorrents === 'object'
        ? Object.entries(syncTorrents).map(([hash, torrent]) => ({ hash, ...torrent }))
        : torrents;
      betaLog(`${betaClientLogName(client)}: /sync/maindata HTTP ${syncResponse.status}, ${torrents.length} torrent(s)`);
    } catch (err: unknown) {
      betaWarn(`${betaClientLogName(client)}: fallback /sync/maindata KO - ${err instanceof Error ? err.message : String(err)}`);
      // Keep the regular torrents/info result when sync/maindata is unavailable.
    }
  }
  const groups = new Map<string, QbitTrackerAggregate>();
  const headers = jar.length ? { Cookie: jar.join('; ') } : undefined;
  let missingAnnounce = 0;
  let trackerDetailCalls = 0;
  let unknownSkipped = 0;
  for (const torrent of torrents) {
    let announce = String(torrent.tracker || '');
    if (!announce || trackerHost(announce) === 'unknown') {
      missingAnnounce += 1;
      const hash = String(torrent.hash || '');
      if (hash) {
        try {
          trackerDetailCalls += 1;
          const trackersResponse = await axios.get(`${baseUrl}/api/v2/torrents/trackers`, {
            timeout: 6000,
            headers,
            params: { hash },
            validateStatus: () => true,
            ...directRequest,
          });
          if (trackersResponse.status >= 400) {
            betaWarn(`${betaClientLogName(client)}: trackers detail HTTP ${trackersResponse.status} pour ${String(torrent.name || hash).slice(0, 80)}`);
            continue;
          }
          const trackers = Array.isArray(trackersResponse.data) ? trackersResponse.data as Array<Record<string, unknown>> : [];
          const preferred = trackers.find(item => {
            const url = String(item.url || '');
            return /^https?:\/\//i.test(url);
          });
          announce = String(preferred?.url || trackers[0]?.url || '');
        } catch (err: unknown) {
          betaWarn(`${betaClientLogName(client)}: trackers detail KO pour ${String(torrent.name || hash).slice(0, 80)} - ${err instanceof Error ? err.message : String(err)}`);
          // Best effort: qBittorrent peut refuser le detail trackers selon permissions/version.
        }
      }
    }
    const host = trackerHost(announce || String(torrent.magnet_uri || 'unknown'));
    if (host === 'unknown') {
      unknownSkipped += 1;
      continue;
    }
    const existing = groups.get(host) ?? {
      clientId: client.id,
      clientLabel: client.label,
      clientBaseUrl: baseUrl,
      trackerHost: host,
      torrentCount: 0,
      seedingCount: 0,
      leechingCount: 0,
      uploadedBytes: 0,
      downloadedBytes: 0,
      ratio: null,
      totalSizeBytes: 0,
      torrents: [],
    };
    const state = String(torrent.state || '');
    const up = Number(torrent.uploaded ?? torrent.uploaded_session ?? 0);
    const down = Number(torrent.downloaded ?? torrent.downloaded_session ?? 0);
    existing.torrentCount += 1;
    existing.seedingCount += state.toLowerCase().includes('up') || state.toLowerCase().includes('seed') ? 1 : 0;
    existing.leechingCount += state.toLowerCase().includes('down') || state.toLowerCase().includes('meta') ? 1 : 0;
    existing.uploadedBytes += Number.isFinite(up) ? up : 0;
    existing.downloadedBytes += Number.isFinite(down) ? down : 0;
    existing.totalSizeBytes += Number(torrent.size ?? 0) || 0;
    existing.torrents.push({
      hash: String(torrent.hash || ''),
      name: String(torrent.name || ''),
      state,
      progress: Number(torrent.progress ?? 0) || 0,
      sizeBytes: Number(torrent.size ?? 0) || 0,
      uploadedBytes: Number.isFinite(up) ? up : 0,
      downloadedBytes: Number.isFinite(down) ? down : 0,
      ratio: Number.isFinite(Number(torrent.ratio)) ? Number(torrent.ratio) : null,
    });
    groups.set(host, existing);
  }
  if (missingAnnounce || trackerDetailCalls || unknownSkipped) {
    betaLog(`${betaClientLogName(client)}: annonces absentes dans torrents/info ${missingAnnounce}, appels detail trackers ${trackerDetailCalls}, torrents sans hote ${unknownSkipped}`);
  }
  for (const item of groups.values()) {
    item.ratio = item.downloadedBytes > 0
      ? item.uploadedBytes / item.downloadedBytes
      : (item.uploadedBytes > 0 ? Number.POSITIVE_INFINITY : 0);
  }
  const result = [...groups.values()].sort((a, b) => a.trackerHost.localeCompare(b.trackerHost));
  betaLog(`${betaClientLogName(client)}: ${result.reduce((sum, item) => sum + item.torrentCount, 0)} torrent(s), ${result.length} hote(s) d'annonce${result.length ? `: ${result.map(item => `${item.trackerHost}=${item.torrentCount}`).join(', ')}` : ''}`);
  if (!result.length && torrents.length > 0) {
    betaWarn(`${betaClientLogName(client)}: ${torrents.length} torrent(s) recus mais aucun hote d'annonce exploitable`);
  }
  if (!torrents.length) {
    betaWarn(`${betaClientLogName(client)}: aucun torrent recupere depuis l'API qBittorrent. Verifier URL API, identifiants, instance cible et droits WebUI.`);
  }
  return result;
}

function xmlRpcValue(value: string): string {
  return `<value><string>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string></value>`;
}

async function rtorrentRpc(client: BetaQbitClient, method: string, params: string[] = []): Promise<string> {
  const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(value => `<param>${xmlRpcValue(value)}</param>`).join('')}</params></methodCall>`;
  const response = await axios.post(cleanClientBaseUrl(client.baseUrl), body, {
    timeout: 12000,
    auth: client.username || client.password ? { username: client.username ?? '', password: client.password ?? '' } : undefined,
    headers: { 'Content-Type': 'text/xml' },
    proxy: false,
  });
  return String(response.data || '');
}

function parseXmlRpcScalars(xml: string): string[] {
  const values: string[] = [];
  const re = /<(?:string|i4|i8|int|double|boolean)>([\s\S]*?)<\/(?:string|i4|i8|int|double|boolean)>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    values.push(match[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim());
  }
  return values;
}

async function fetchRutorrentClient(client: BetaQbitClient): Promise<QbitTrackerAggregate[]> {
  const baseUrl = cleanClientBaseUrl(client.baseUrl);
  betaLog(`${betaClientLogName(client)}: scan ruTorrent/rTorrent sur ${baseUrl}`);
  await rtorrentRpc(client, 'download_list', ['main']);
  const xml = await rtorrentRpc(client, 'd.multicall2', [
    '',
    'main',
    'd.hash=',
    'd.name=',
    'd.state=',
    'd.size_bytes=',
    'd.up.total=',
    'd.down.total=',
    'd.ratio=',
    'd.complete=',
  ]);
  const scalars = parseXmlRpcScalars(xml);
  betaLog(`${betaClientLogName(client)}: d.multicall2 a retourne ${scalars.length} valeur(s), ${Math.floor(scalars.length / 8)} torrent(s) potentiel(s)`);
  const groups = new Map<string, QbitTrackerAggregate>();
  let trackerDetailCalls = 0;
  let unknownSkipped = 0;
  for (let i = 0; i + 7 < scalars.length; i += 8) {
    const [hash, name, stateRaw, sizeRaw, upRaw, downRaw, ratioRaw, completeRaw] = scalars.slice(i, i + 8);
    let announce = '';
    try {
      trackerDetailCalls += 1;
      const trackersXml = await rtorrentRpc(client, 't.multicall', [hash, '', 't.url=']);
      announce = parseXmlRpcScalars(trackersXml).find(value => /^https?:\/\//i.test(value)) || '';
      betaLog(`${betaClientLogName(client)}: ${name.slice(0, 80)} -> ${redactedAnnounceForLog(announce)}`);
    } catch (err: unknown) {
      betaWarn(`${betaClientLogName(client)}: t.multicall KO pour ${name.slice(0, 80)} - ${err instanceof Error ? err.message : String(err)}`);
      // Some ruTorrent/rTorrent setups disable tracker multicalls; keep torrent under unknown.
    }
    const host = trackerHost(announce);
    if (host === 'unknown') unknownSkipped += 1;
    const up = Number(upRaw) || 0;
    const down = Number(downRaw) || 0;
    const complete = completeRaw === '1';
    const existing = groups.get(host) ?? {
      clientId: client.id,
      clientLabel: client.label,
      clientBaseUrl: baseUrl,
      trackerHost: host,
      torrentCount: 0,
      seedingCount: 0,
      leechingCount: 0,
      uploadedBytes: 0,
      downloadedBytes: 0,
      ratio: null,
      totalSizeBytes: 0,
      torrents: [],
    };
    existing.torrentCount += 1;
    existing.seedingCount += complete ? 1 : 0;
    existing.leechingCount += complete ? 0 : 1;
    existing.uploadedBytes += up;
    existing.downloadedBytes += down;
    existing.totalSizeBytes += Number(sizeRaw) || 0;
    existing.torrents.push({
      hash,
      name,
      state: stateRaw === '1' ? (complete ? 'seeding' : 'leeching') : 'stopped',
      progress: complete ? 1 : 0,
      sizeBytes: Number(sizeRaw) || 0,
      uploadedBytes: up,
      downloadedBytes: down,
      ratio: Number.isFinite(Number(ratioRaw)) ? Number(ratioRaw) / 1000 : null,
    });
    groups.set(host, existing);
  }
  if (trackerDetailCalls || unknownSkipped) {
    betaLog(`${betaClientLogName(client)}: appels detail trackers ${trackerDetailCalls}, torrents sans hote ${unknownSkipped}`);
  }
  for (const item of groups.values()) {
    item.ratio = item.downloadedBytes > 0
      ? item.uploadedBytes / item.downloadedBytes
      : (item.uploadedBytes > 0 ? Number.POSITIVE_INFINITY : 0);
  }
  const result = [...groups.values()].sort((a, b) => a.trackerHost.localeCompare(b.trackerHost));
  betaLog(`${betaClientLogName(client)}: ${result.reduce((sum, item) => sum + item.torrentCount, 0)} torrent(s), ${result.length} hote(s) d'annonce${result.length ? `: ${result.map(item => `${item.trackerHost}=${item.torrentCount}`).join(', ')}` : ''}`);
  return result;
}

async function fetchTorrentClient(client: BetaQbitClient): Promise<QbitTrackerAggregate[]> {
  return client.type === 'rutorrent' ? fetchRutorrentClient(client) : fetchQbitClient(client);
}

async function refreshBetaQbitStats(settings = loadBetaSettings()): Promise<QbitTrackerAggregate[]> {
  const enabled = settings.qbitClients.filter(client => client.enabled);
  betaLog(`refresh demande: ${settings.qbitClients.length} client(s) configure(s), ${enabled.length} actif(s)`);
  if (!enabled.length) {
    betaWarn('aucun client BitTorrent actif dans la configuration beta');
  }
  const results: QbitTrackerAggregate[] = [];
  const errors: string[] = [];
  for (const client of enabled) {
    try {
      const clientResults = await fetchTorrentClient(client);
      results.push(...clientResults);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${betaClientLogName(client)}: ${message}`);
      betaWarn(`${betaClientLogName(client)}: scan KO - ${message}`);
    }
  }
  if (errors.length && !results.length) {
    throw new Error(`Scan BitTorrent KO: ${errors.join(' | ')}`);
  }
  if (errors.length) {
    betaWarn(`scan partiel: ${errors.length} client(s) en erreur`);
  }
  betaQbitStats = results;
  betaQbitLastRefresh = new Date().toISOString();
  // Un scan complet remet à zéro l'échéance auto de tous les clients actifs.
  const now = Date.now();
  for (const client of enabled) qbitClientLastScan.set(client.id, now);
  const torrentCount = results.reduce((sum, item) => sum + item.torrentCount, 0);
  betaLog(`refresh termine: ${torrentCount} torrent(s), ${results.length} hote(s) d'annonce`);
  if (enabled.length > 0 && torrentCount === 0) {
    throw new Error('Aucun torrent recupere depuis les clients BitTorrent actifs. Les logs [Beta BitTorrent] indiquent quel endpoint repond vide ou invalide.');
  }
  return results;
}

// Rescanne un seul client BitTorrent et fusionne son résultat dans betaQbitStats
// (remplace uniquement les agrégats de ce client). Best-effort : une erreur ne
// touche pas les données des autres clients. Utilisé par le rafraîchissement
// automatique par intervalle (voir startScheduler).
async function refreshSingleQbitClient(client: BetaQbitClient): Promise<void> {
  try {
    const clientResults = await fetchTorrentClient(client);
    betaQbitStats = betaQbitStats.filter(stat => stat.clientId !== client.id).concat(clientResults);
    betaQbitLastRefresh = new Date().toISOString();
    const torrentCount = clientResults.reduce((sum, item) => sum + item.torrentCount, 0);
    betaLog(`auto-refresh ${betaClientLogName(client)}: ${torrentCount} torrent(s), ${clientResults.length} hote(s)`);
  } catch (err: unknown) {
    betaWarn(`auto-refresh ${betaClientLogName(client)} KO - ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function sendBetaNotification(
  target: BetaNotificationTarget,
  message: string,
  title = 'Tracker Dashboard Beta',
): Promise<void> {
  if (target.type === 'discord') {
    const content = `**${title}**\n${message}`.slice(0, 2000);
    await axios.post(target.url, { content }, { timeout: 8000 });
    return;
  }
  if (!target.urls?.length) throw new Error('Aucune URL de destination Apprise configuree');
  const endpoint = `${target.url.replace(/\/$/, '')}/notify/`;
  await axios.post(endpoint, {
    title,
    body: message,
    urls: (target.urls ?? []).join('\n'),
  }, { timeout: 10_000 });
}

export async function start(): Promise<void> {
  importLegacySettingsIfNeeded();
  importLegacyCredentialsIfNeeded();
  importLegacyTrackersIfNeeded();
  let trackers = normalizeTrackerConfigs();

  const app = express();
  app.use(express.json());

  app.get('/login.html', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  app.get('/logo.png', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'logo.png'));
  });

  app.get('/favicon.png', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'favicon.png'));
  });

  app.get('/api/auth/status', (req, res) => {
    res.json({
      configured: isAuthConfigured(),
      authenticated: verifySessionCookie(readCookie(req.headers.cookie, SESSION_COOKIE)),
    });
  });

  app.post('/api/auth/setup', (req, res) => {
    if (isAuthConfigured()) return res.status(409).json({ ok: false, error: 'Compte deja configure' });
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password || password.length < 8) {
      return res.status(400).json({ ok: false, error: 'Utilisateur et mot de passe de 8 caracteres minimum requis' });
    }
    saveAuthSettings(username, password);
    const session = createSessionCookie(username);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`);
    res.json({ ok: true });
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password || !verifyLogin(username, password)) {
      return res.status(401).json({ ok: false, error: 'Identifiants invalides' });
    }
    const session = createSessionCookie(username);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // ── Prometheus /metrics (token, hors session) ──────────────────────────────
  app.get(['/metrics', '/metrics/'], (req, res) => {
    const token = process.env.METRICS_TOKEN;
    const publicMetrics = String(process.env.METRICS_PUBLIC ?? '').toLowerCase() === 'true';
    if (!token && !publicMetrics) {
      res.status(503).type('text/plain').send('METRICS_TOKEN env var not set on the server');
      return;
    }
    const auth = req.headers.authorization;
    if (!publicMetrics && auth !== `Bearer ${token}`) {
      res.status(401).type('text/plain').send('Unauthorized');
      return;
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderPrometheusMetrics(cachedStats));
  });

  app.use((req, res, next) => {
    if (!isAuthConfigured()) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ ok: false, error: 'Compte admin non configure' });
      }
      return res.redirect('/login.html');
    }
    if (verifySessionCookie(readCookie(req.headers.cookie, SESSION_COOKIE))) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'Authentification requise' });
    }
    return res.redirect('/login.html');
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
  app.use(express.static(PUBLIC_DIR, { index: false }));

  app.get('/api/build-info', (_req, res) => {
    const imageSource = process.env.APP_IMAGE_SOURCE?.trim() || 'local';
    res.json({
      imageSource,
      legacyImage: imageSource.toLowerCase() === 'ghcr.io/aerya/tracker-dashboard',
    });
  });

  // ── Stats ──────────────────────────────────────────────────────────────────
  app.get('/api/stats', (_req, res) => {
    if (isPresentationMode()) {
      return res.json({
        stats: applyTrackerOrder(fakeStatsForPresentation()),
        lastRefresh: new Date().toISOString(),
        isRefreshing: false,
        presentationMode: true,
      });
    }
    trackers = normalizeTrackerConfigs();
    const qbitSeeding = qbitSeedingByTrackerId(trackers);
    const stats = applyTrackerOrder(visibleStats(trackers)).map(stat => {
      const entry = qbitSeeding.get(stat.id);
      return {
        ...stat,
        qbitSeeding: entry ? entry.count : null,
        qbitSeedingTypes: entry ? [...entry.types] : [],
      };
    });
    res.json({ stats, lastRefresh, isRefreshing });
  });

  app.post('/api/refresh', (_req, res) => {
    trackers = normalizeTrackerConfigs();
    if (isPresentationMode()) {
      cachedStats = fakeStatsForPresentation();
      lastRefresh = new Date().toISOString();
      return res.json({ ok: true, presentationMode: true });
    }
    refresh(trackers);
    res.json({ ok: true });
  });

  app.post('/api/refresh/:trackerId', async (req, res) => {
    trackers = normalizeTrackerConfigs();
    if (isPresentationMode()) {
      const stat = fakeStatsForPresentation().find(item => item.id === req.params.trackerId);
      if (!stat) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });
      return res.json({ ok: true, stat, presentationMode: true });
    }
    const tracker = trackers.find(t => t.id === req.params.trackerId && t.enabled !== false);
    if (!tracker) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });
    const stat = await refreshOneTracker(tracker);
    res.json({ ok: true, stat });
  });

  app.get('/api/config', (_req, res) => {
    trackers = normalizeTrackerConfigs();
    const safe = trackers.map(({ id, name, baseUrl, enabled, dashboard, ratioless }) => ({
      id,
      name,
      baseUrl,
      enabled: enabled !== false,
      byteUnit: dashboard?.byteUnit ?? 'binary',
      ratioless: Boolean(ratioless),
    }));
    res.json({ trackers: safe });
  });

  app.get('/api/beta/overview', (_req, res) => {
    trackers = normalizeTrackerConfigs();
    const settings = loadBetaSettings();
    const trackerHosts = new Map<string, string>();
    for (const tracker of trackers) {
      const host = trackerHost(tracker.baseUrl);
      trackerHosts.set(host, tracker.id);
      trackerHosts.set(hostDomainKey(host), tracker.id);
    }
    for (const mapping of settings.announceMappings) {
      const host = trackerHost(mapping.announceHost);
      trackerHosts.set(host, mapping.trackerId);
      trackerHosts.set(hostDomainKey(host), mapping.trackerId);
    }
    const qbitByTracker = betaQbitStats.map(item => ({
      ...item,
      trackerId: betaTrackerIdForAnnounceHost(item.trackerHost, trackerHosts, trackers),
    }));
    const cookieSummaries = listTrackerDefinitionFiles().map(definition => {
      const configured = trackers.find(tracker => tracker.id === definition.id);
      const hasCookie = hasTrackerCookie(definition.id);
      const cookieOnly = Boolean(configured?.login?.cookieOnly ?? loadTrackerDefinitionFile(definition.id)?.login?.cookieOnly);
      return { trackerId: definition.id, trackerName: definition.name, hasCookie, cookieOnly };
    });
    res.json({
      ok: true,
      settings: sanitizeBetaSettings(settings),
      qbitStats: qbitByTracker,
      qbitLastRefresh: betaQbitLastRefresh,
      trackerStatuses: visibleStats(trackers).map(stat => ({
        id: stat.id,
        name: stat.name,
        status: stat.status,
        stale: Boolean(stat.stale),
        ratioless: Boolean(trackers.find(tracker => tracker.id === stat.id)?.ratioless),
        mode: stat.status === 'ok'
          ? (hasTrackerCookie(stat.id) ? 'cookie-only' : 'fonctionne')
          : (stat.error?.toLowerCase().includes('captcha') || stat.error?.toLowerCase().includes('cloudflare') ? 'captcha' : 'cassé'),
        siteReachability: stat.stale?.siteReachability ?? stat.siteReachability ?? null,
      })),
      cookieSummaries,
    });
  });

  app.get('/api/beta/history', (req, res) => {
    const trackerId = typeof req.query.trackerId === 'string' && req.query.trackerId ? req.query.trackerId : null;
    const limit = Number(req.query.limit ?? 500);
    res.json({ ok: true, snapshots: listStatSnapshots(trackerId, limit) });
  });

  app.get('/api/beta/settings', (_req, res) => {
    res.json({ ok: true, settings: sanitizeBetaSettings(loadBetaSettings()) });
  });

  app.post('/api/beta/settings', (req, res) => {
    try {
      const settings = saveBetaSettingsPayload(req.body);
      console.log(`[Beta BitTorrent] configuration sauvegardee: ${settings.qbitClients.length} client(s), ${settings.qbitClients.filter(client => client.enabled).length} actif(s), ${settings.announceMappings.length} liaison(s) annonce`);
      res.json({ ok: true, settings: sanitizeBetaSettings(settings) });
    } catch (err: unknown) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/beta/qbit/test', async (req, res) => {
    try {
      const raw = req.body as Partial<BetaQbitClient>;
      const current = loadBetaSettings().qbitClients.find(item => item.id === raw.id);
      const client: BetaQbitClient = {
        id: raw.id || 'test',
        type: raw.type === 'rutorrent' ? 'rutorrent' : 'qbittorrent',
        label: String(raw.label || (raw.type === 'rutorrent' ? 'ruTorrent' : 'qBittorrent')).trim() || 'Client BitTorrent',
        baseUrl: cleanClientBaseUrl(String(raw.baseUrl || '')),
        username: String(raw.username || '').trim(),
        password: raw.password === '••••••••' ? (current?.password ?? '') : (raw.password ?? ''),
        enabled: true,
      };
      betaLog(`test client demande pour ${betaClientLogName(client)}`);
      const stats = await fetchTorrentClient(client);
      res.json({ ok: true, trackerCount: stats.length, torrentCount: stats.reduce((sum, item) => sum + item.torrentCount, 0) });
    } catch (err: unknown) {
      betaWarn(`test client KO - ${err instanceof Error ? err.message : String(err)}`);
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/beta/qbit/refresh', async (_req, res) => {
    try {
      betaLog('endpoint /api/beta/qbit/refresh appele');
      const stats = await refreshBetaQbitStats();
      betaLog(`endpoint refresh OK: ${stats.reduce((sum, item) => sum + item.torrentCount, 0)} torrent(s), ${stats.length} hote(s)`);
      res.json({ ok: true, stats, lastRefresh: betaQbitLastRefresh });
    } catch (err: unknown) {
      betaWarn(`endpoint refresh KO - ${err instanceof Error ? err.message : String(err)}`);
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/beta/notifications/test', async (req, res) => {
    const settings = loadBetaSettings();
    const id = typeof req.body?.targetId === 'string' ? req.body.targetId : '';
    const target = settings.notificationTargets.find(item => item.id === id);
    if (!target) return res.status(404).json({ ok: false, error: 'Destination introuvable' });
    try {
      await sendBetaNotification(target, 'Test Tracker Dashboard Beta : notification recue.');
      res.json({ ok: true });
    } catch (err: unknown) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/beta/trackers/:trackerId/proxy-check', async (req, res) => {
    trackers = normalizeTrackerConfigs();
    const tracker = trackers.find(item => item.id === req.params.trackerId)
      ?? loadTrackerDefinitionFile(req.params.trackerId);
    if (!tracker) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });
    try {
      await ensureProxyReady(tracker.id);
      const started = Date.now();
      const response = await axios.get(tracker.baseUrl, {
        ...buildProxyConfig(resolveProxyForTracker(tracker.id)),
        timeout: 10000,
        validateStatus: () => true,
      });
      res.json({
        ok: response.status < 500,
        status: response.status,
        ms: Date.now() - started,
        url: tracker.baseUrl,
      });
    } catch (err: unknown) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err), url: tracker.baseUrl });
    }
  });

  app.get('/api/trackers', (_req, res) => {
    trackers = normalizeTrackerConfigs();
    res.json({ trackers });
  });

  app.get('/api/tracker-definitions', (_req, res) => {
    importLegacyTrackersIfNeeded();
    trackers = normalizeTrackerConfigs();
    const configured = new Map(trackers.map(tracker => [tracker.id, tracker]));
    const definitions = listTrackerDefinitionFiles()
      .map(definition => {
        const configuredTracker = configured.get(definition.id);
        return {
          ...definition,
          enabled: Boolean(configuredTracker && configuredTracker.enabled !== false),
          configured: Boolean(configuredTracker),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    const seen = getJsonSetting(TRACKER_DEFINITIONS_SEEN_KEY, { ids: [] as string[] });
    const seenIds = new Set(Array.isArray(seen.ids) ? seen.ids : []);
    res.json({
      definitions,
      newDefinitions: definitions.filter(definition => !definition.configured && !seenIds.has(definition.id)),
    });
  });

  app.post('/api/tracker-definitions/seen', (_req, res) => {
    const ids = listTrackerDefinitionFiles().map(definition => definition.id);
    setJsonSetting(TRACKER_DEFINITIONS_SEEN_KEY, { ids });
    res.json({ ok: true });
  });

  app.post('/api/settings/tracker-order', (req, res) => {
    const order = req.body?.order;
    if (!Array.isArray(order) || order.some(id => typeof id !== 'string')) {
      return res.status(400).json({ ok: false, error: 'Ordre des trackers invalide' });
    }

    const knownIds = new Set(normalizeTrackerConfigs().map(tracker => tracker.id));
    const ids = [...new Set(order)].filter(id => knownIds.has(id));
    setJsonSetting(TRACKER_ORDER_KEY, { ids });
    res.json({ ok: true, order: ids });
  });

  app.post('/api/trackers/:trackerId/enabled', (req, res) => {
    importLegacyTrackersIfNeeded();
    trackers = normalizeTrackerConfigs();
    const tracker = trackers.find(t => t.id === req.params.trackerId)
      ?? loadTrackerDefinitionFile(req.params.trackerId);
    if (!tracker) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });

    tracker.enabled = Boolean(req.body.enabled);
    saveTrackerConfig(tracker);
    trackers = normalizeTrackerConfigs();
    res.json({ ok: true, tracker });
  });

  app.post('/api/trackers', (req, res) => {
    try {
      const config = req.body as TrackerConfig;
      if (!config.id || !config.name || !config.baseUrl || !config.login || !config.fetch) {
        return res.status(400).json({ ok: false, error: 'Config tracker incomplete' });
      }
      saveTrackerConfig(config);
      trackers = loadTrackerConfigsFromDb();
      res.json({ ok: true, tracker: config });
    } catch (err: unknown) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Proxy settings ─────────────────────────────────────────────────────────
  app.get('/api/settings/presentation', (_req, res) => {
    res.json(getJsonSetting(PRESENTATION_MODE_KEY, { enabled: false }));
  });

  app.post('/api/settings/presentation', (req, res) => {
    const enabled = Boolean(req.body.enabled);
    setJsonSetting(PRESENTATION_MODE_KEY, { enabled });
    if (enabled) {
      cachedStats = fakeStatsForPresentation();
      lastRefresh = new Date().toISOString();
    }
    res.json({ ok: true, enabled });
  });

  // ── Ordre des tuiles (drag & drop dashboard) ───────────────────────────────
  app.get('/api/settings/tracker-order', (_req, res) => {
    res.json({ order: getJsonSetting<string[]>(TRACKER_ORDER_KEY, []) });
  });

  app.post('/api/settings/tracker-order', (req, res) => {
    const order = Array.isArray(req.body?.order)
      ? req.body.order.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    setJsonSetting(TRACKER_ORDER_KEY, order);
    res.json({ ok: true, order });
  });

  app.get('/api/schedules', (_req, res) => {
    res.json({ schedules: listTrackerSchedules() });
  });

  app.get('/api/credentials', (_req, res) => {
    trackers = normalizeTrackerConfigs();
    const credentials = new Map(listTrackerCredentialSummaries().map(c => [c.trackerId, c]));
    const configured = new Map(trackers.map(tracker => [tracker.id, tracker]));
    res.json({
      credentials: listTrackerDefinitionFiles()
        .map(definition => {
          const tracker = configured.get(definition.id);
          return {
            trackerId: definition.id,
            trackerName: definition.name,
            enabled: Boolean(tracker && tracker.enabled !== false),
            configured: Boolean(tracker),
            username: credentials.get(definition.id)?.username ?? '',
            hasPassword: credentials.get(definition.id)?.hasPassword ?? false,
            hasCookie: hasTrackerCookie(definition.id),
            hasTotp: hasTrackerTotpSecret(definition.id),
            cookieOnly: Boolean(tracker?.login?.cookieOnly ?? loadTrackerDefinitionFile(definition.id)?.login?.cookieOnly),
            updatedAt: credentials.get(definition.id)?.updatedAt ?? null,
          };
        })
        .sort((a, b) => a.trackerName.localeCompare(b.trackerName, 'fr', { sensitivity: 'base' })),
    });
  });

  app.post('/api/credentials/:trackerId', (req, res) => {
    trackers = loadTrackerConfigsFromDb();
    const tracker = trackers.find(t => t.id === req.params.trackerId)
      ?? loadTrackerDefinitionFile(req.params.trackerId);
    if (!tracker) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });

    const { username, password } = req.body as { username?: string; password?: string };
    const current = getTrackerCredentials(tracker.id);
    const nextUsername = username ?? current?.username ?? '';
    const nextPassword = password === '••••••••' ? current?.password : password;

    if (!nextUsername || !nextPassword) {
      return res.status(400).json({ ok: false, error: 'Utilisateur et mot de passe requis' });
    }

    tracker.enabled = true;
    saveTrackerConfig(tracker);
    saveTrackerCredentials(tracker.id, nextUsername, nextPassword);
    invalidateSession(tracker.id);
    res.json({ ok: true });
  });

  app.delete('/api/credentials/:trackerId', (req, res) => {
    trackers = normalizeTrackerConfigs();
    const tracker = trackers.find(t => t.id === req.params.trackerId)
      ?? loadTrackerDefinitionFile(req.params.trackerId);
    if (!tracker) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });
    deleteTrackerCredentials(tracker.id);
    invalidateSession(tracker.id);
    res.json({ ok: true });
  });

  app.get('/api/settings/proxy', (_req, res) => {
    const proxy = loadProxySettings();
    // Ne jamais renvoyer les secrets en clair — juste indiquer s'ils sont définis
    res.json({
      ...proxy,
      password: proxy.password ? '••••••••' : '',
      privateKey: proxy.privateKey ? '••••••••' : '',
      passphrase: proxy.passphrase ? '••••••••' : '',
    });
  });

  app.post('/api/settings/proxy', (req, res) => {
    try {
      const {
        enabled,
        type,
        host,
        port,
        username,
        password,
        privateKey,
        passphrase,
        directConnectAllowed,
      } = req.body as ProxySettings;
      const current = loadProxySettings();
      const updated: ProxySettings = {
        enabled: Boolean(enabled),
        type:     type     ?? current.type,
        host:     host     ?? current.host,
        port:     port     ?? current.port,
        username: username ?? current.username,
        // Si le client renvoie les bullets, on garde l'ancien secret
        password: password === '••••••••' ? current.password : (password ?? current.password),
        privateKey: privateKey === '••••••••' ? current.privateKey : (privateKey ?? current.privateKey),
        passphrase: passphrase === '••••••••' ? current.passphrase : (passphrase ?? current.passphrase),
        directConnectAllowed: Boolean(directConnectAllowed),
      };
      saveProxySettings(updated);
      // Invalider toutes les sessions — elles reprendront avec le nouveau proxy
      invalidateAllSessions();
      console.log(`[Proxy] Config mise à jour — ${updated.enabled ? `${updated.type}://${updated.host}:${updated.port}` : 'désactivé'}`);
      res.json({ ok: true });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[Proxy] Impossible de sauvegarder la config :', error);
      res.status(500).json({ ok: false, error });
    }
  });

  // ── Moteur navigateur : chromium (defaut) ou cloak (CloakBrowser furtif) ──
  app.get('/api/settings/browser-engine', (_req, res) => {
    res.json({ engine: getJsonSetting('browser_engine', 'chromium') });
  });

  app.post('/api/settings/browser-engine', (req, res) => {
    const engine = req.body?.engine === 'cloak' ? 'cloak' : 'chromium';
    setJsonSetting('browser_engine', engine);
    // On ferme les contextes navigateur existants pour repartir sur le bon moteur.
    invalidateAllSessions();
    console.log(`[Navigateur] Moteur sélectionné : ${engine === 'cloak' ? 'CloakBrowser (furtif)' : 'Chromium'}`);
    res.json({ ok: true, engine });
  });

  // ── Fast-path curl-impersonate (lecture HTTP impersonee avant navigateur) ──
  app.get('/api/settings/fast-fetch', (_req, res) => {
    res.json({ enabled: getJsonSetting('fast_fetch', true as boolean) !== false });
  });

  app.post('/api/settings/fast-fetch', (req, res) => {
    const enabled = req.body?.enabled !== false;
    setJsonSetting('fast_fetch', enabled);
    console.log(`[Fast-path] curl-impersonate ${enabled ? 'activé' : 'désactivé'}`);
    res.json({ ok: true, enabled });
  });

  // ── Proxies par tracker (overrides) ───────────────────────────────────────
  app.get('/api/settings/proxy-overrides', (_req, res) => {
    // On masque les passwords par des bullets (cote front on differencie ainsi
    // "rien" de "deja defini, ne pas reecrire")
    const sanitized = loadProxyOverrides().map(o => ({
      ...o,
      password: o.password ? '••••••••' : '',
      privateKey: o.privateKey ? '••••••••' : '',
      passphrase: o.passphrase ? '••••••••' : '',
    }));
    res.json({ ok: true, overrides: sanitized });
  });

  app.post('/api/settings/proxy-overrides', (req, res) => {
    try {
      const incoming = req.body?.overrides;
      if (!Array.isArray(incoming)) {
        return res.status(400).json({ ok: false, error: 'Payload invalide — { overrides: [] } attendu' });
      }
      const previous = loadProxyOverrides();
      const previousById = new Map(previous.map(o => [o.id, o]));

      const validTrackerIds = new Set(normalizeTrackerConfigs().map(t => t.id));
      const seenInEnabled = new Map<string, string>(); // trackerId -> overrideLabel

      const cleaned: ProxyOverride[] = [];
      for (const raw of incoming) {
        if (!raw || typeof raw !== 'object') continue;
        const id = typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID();
        const prev = previousById.get(id);
        const passwordIn = typeof raw.password === 'string' ? raw.password : '';
        const isDirect = Boolean(raw.direct) || raw.type === 'direct';
        const isSsh = !isDirect && raw.type === 'ssh';
        const privateKeyIn = typeof raw.privateKey === 'string' ? raw.privateKey : '';
        const passphraseIn = typeof raw.passphrase === 'string' ? raw.passphrase : '';
        const override: ProxyOverride = {
          id,
          label:    typeof raw.label === 'string' ? raw.label.trim().slice(0, 64) : '',
          enabled:  Boolean(raw.enabled),
          direct:   Boolean(raw.direct) || raw.type === 'direct',
          trackers: Array.isArray(raw.trackers)
            ? Array.from(new Set(raw.trackers.filter((t: unknown): t is string => typeof t === 'string' && validTrackerIds.has(t))))
            : [],
          type:     Boolean(raw.direct) || raw.type === 'direct' ? 'direct' : (typeof raw.type === 'string' ? raw.type : 'socks5'),
          host:     Boolean(raw.direct) || raw.type === 'direct' ? '' : (typeof raw.host === 'string' ? raw.host.trim() : ''),
          port:     Boolean(raw.direct) || raw.type === 'direct' ? '' : (typeof raw.port === 'string' || typeof raw.port === 'number' ? String(raw.port).trim() : ''),
          username: typeof raw.username === 'string' ? raw.username.trim() : '',
          // Si le front renvoie les bullets, on conserve le mot de passe existant
          password: passwordIn === '••••••••' ? (prev?.password ?? '') : passwordIn,
          // Secrets SSH (idem : bullets => on garde l'existant). Vides hors mode SSH.
          privateKey: !isSsh ? '' : (privateKeyIn === '••••••••' ? (prev?.privateKey ?? '') : privateKeyIn),
          passphrase: !isSsh ? '' : (passphraseIn === '••••••••' ? (prev?.passphrase ?? '') : passphraseIn),
        };

        if (override.enabled) {
          for (const tid of override.trackers) {
            const otherLabel = seenInEnabled.get(tid);
            if (otherLabel !== undefined) {
              return res.status(400).json({
                ok: false,
                error: `Le tracker "${tid}" est cible par plusieurs proxys actifs ("${otherLabel}" et "${override.label || override.id}"). Un tracker ne peut etre couvert que par un seul proxy actif a la fois.`,
              });
            }
            seenInEnabled.set(tid, override.label || override.id);
          }
        }

        cleaned.push(override);
      }

      // Calcul des trackers impactes (info pour logs) : union des trackers cibles AVANT et APRES
      const affected = new Set<string>();
      for (const o of previous) for (const t of o.trackers) affected.add(t);
      for (const o of cleaned)  for (const t of o.trackers) affected.add(t);

      saveProxyOverrides(cleaned);
      // invalidateAllSessions ferme aussi tous les contextes Playwright -
      // pas besoin de fermer individuellement les overrides
      invalidateAllSessions();
      console.log(`[Proxy] Overrides sauves (${cleaned.length}) — sessions invalidees (${affected.size} tracker(s) impactes)`);
      res.json({ ok: true, count: cleaned.length });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[Proxy] Sauvegarde overrides KO :', error);
      res.status(500).json({ ok: false, error });
    }
  });

  // ── Cookie de session manuel (sites a CAPTCHA / Cloudflare Turnstile) ──────
  app.post('/api/trackers/:trackerId/cookie', async (req, res) => {
    const id = req.params.trackerId;
    if (!new Set(listTrackerDefinitionFiles().map(t => t.id)).has(id)) {
      return res.status(404).json({ ok: false, error: 'Tracker inconnu' });
    }
    const cookie = typeof req.body?.cookie === 'string' ? req.body.cookie : '';
    setTrackerCookie(id, cookie);
    // Un nouveau cookie colle remplace la valeur stockee. On purge aussi le profil
    // navigateur persistant pour eviter de conserver d'anciens cookies non presents
    // dans le nouveau collage.
    await resetBrowserProfile(id);
    invalidateSession(id);
    console.log(`[Cookies] ${id} : cookie de session ${cookie.trim() ? 'enregistre' : 'efface'}`);
    res.json({ ok: true, hasCookie: hasTrackerCookie(id) });
  });

  // ── Secret TOTP (2FA) par tracker ─────────────────────────────────────────
  app.post('/api/trackers/:trackerId/totp', (req, res) => {
    const id = req.params.trackerId;
    if (!new Set(listTrackerDefinitionFiles().map(t => t.id)).has(id)) {
      return res.status(404).json({ ok: false, error: 'Tracker inconnu' });
    }
    const secret = typeof req.body?.secret === 'string' ? req.body.secret : '';
    setTrackerTotpSecret(id, secret);
    invalidateSession(id);
    console.log(`[TOTP] ${id} : secret 2FA ${secret.trim() ? 'enregistre' : 'efface'}`);
    res.json({ ok: true, hasTotp: hasTrackerTotpSecret(id) });
  });

  // ── Reset du profil navigateur d'un tracker ───────────────────────────────
  app.post('/api/trackers/:trackerId/reset-profile', async (req, res) => {
    const id = req.params.trackerId;
    if (!new Set(listTrackerDefinitionFiles().map(t => t.id)).has(id)) {
      return res.status(404).json({ ok: false, error: 'Tracker inconnu' });
    }
    try {
      await resetBrowserProfile(id);
      invalidateSession(id); // reset aussi la session HTTP en memoire
      console.log(`[Profil] Profil navigateur de ${id} reinitialise`);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Logos trackers (favicon en cache + logos manuels) ─────────────────────
  app.get('/api/tracker-logo/:id', (req, res) => {
    const file = resolveLogoPath(req.params.id);
    if (!file) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  });

  app.get('/api/tracker-logos', (_req, res) => {
    res.json({ ok: true, missing: listTrackersWithoutLogo(listTrackerDefinitionFiles()) });
  });

  app.post('/api/tracker-logos/refresh', async (_req, res) => {
    try {
      const results = await refreshAllLogos(listTrackerDefinitionFiles(), true);
      res.json({ ok: true, results, missing: results.filter(r => !r.ok) });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Incidents trackers (flag manuel) ──────────────────────────────────────
  app.get('/api/incidents', (_req, res) => {
    res.json({ ok: true, incidents: loadIncidents() });
  });

  app.post('/api/incidents/:trackerId', (req, res) => {
    const trackerId = req.params.trackerId;
    const validIds = new Set(normalizeTrackerConfigs().map(t => t.id));
    if (!validIds.has(trackerId)) {
      return res.status(404).json({ ok: false, error: 'Tracker inconnu' });
    }
    const acknowledged = Boolean(req.body?.acknowledged);
    const note = typeof req.body?.note === 'string' ? req.body.note : '';
    const incident = setIncident(trackerId, acknowledged, note);
    // Nouvel incident marque -> on repart d'un compteur de OK vierge (2 OK requis)
    incidentOkStreaks.delete(trackerId);
    if (acknowledged) retryStates.delete(trackerId);
    // Re-annoter le cache pour que /api/stats reflete immediatement le changement
    const cached = cachedStats.find(s => s.id === trackerId);
    if (cached) upsertCachedStat({ ...cached, incident: undefined });
    res.json({ ok: true, incident });
  });

  app.delete('/api/incidents/:trackerId', (req, res) => {
    clearIncident(req.params.trackerId);
    incidentOkStreaks.delete(req.params.trackerId);
    const cached = cachedStats.find(s => s.id === req.params.trackerId);
    if (cached) upsertCachedStat({ ...cached, incident: undefined });
    res.json({ ok: true });
  });

  app.post('/api/proxy/test', async (req, res) => {
    const { type = 'socks5', host, port, username, password, privateKey, passphrase } = req.body as ProxySettings;
    if (!host || !port) return res.status(400).json({ ok: false, error: 'Hôte et port requis' });

    const current = loadProxySettings();
    const effective: ProxySettings = {
      enabled: true, type, host, port, username,
      password: password === '••••••••' ? current.password : (password ?? ''),
      privateKey: privateKey === '••••••••' ? current.privateKey : (privateKey ?? ''),
      passphrase: passphrase === '••••••••' ? current.passphrase : (passphrase ?? ''),
      directConnectAllowed: current.directConnectAllowed,
    };
    // Proxy SSH : etablir le tunnel avant de construire l'agent SOCKS local.
    if (type === 'ssh') {
      const ssh = toSshConfig(effective);
      if (!ssh) return res.json({ ok: false, error: 'Config SSH invalide (hôte/port/utilisateur requis)' });
      try {
        await ensureSshSocks(ssh);
      } catch (err: unknown) {
        return res.json({ ok: false, error: `Tunnel SSH: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    const cfg = buildProxyConfig(effective);

    try {
      const r = await axios.get<{ ip: string }>('https://api.ipify.org?format=json', {
        ...cfg, timeout: 8000,
      });
      res.json({ ok: true, ip: r.data.ip });
    } catch (err: unknown) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const port = parseInt(process.env.PORT ?? '3000', 10);
  logProxyStatus();
  app.listen(port, () => console.log(startupBanner(port)));

  // Au demarrage : on sert d'abord les dernieres stats en base. On ne re-scrape que
  // les trackers dont la derniere donnee OK a plus de BOOT_FRESH_HOURS (defaut 24h),
  // ou qui n'en ont pas. Evite de relancer 20 navigateurs a chaque restart/MaJ.
  const staleTrackers = hydrateFromSnapshots(trackers);
  const servedFromCache = trackers.filter(t => t.enabled !== false).length - staleTrackers.length;
  if (staleTrackers.length === 0) {
    console.log(`Boot: ${servedFromCache} tracker(s) servis depuis la base (< ${BOOT_FRESH_HOURS}h), aucun scraping au demarrage`);
  } else {
    console.log(`Boot: ${servedFromCache} tracker(s) servis depuis la base, ${staleTrackers.length} obsolete(s)/absent(s) a rafraichir`);
    await refresh(staleTrackers);
  }

  // Recuperation des logos au demarrage (non bloquant). NON force : on ne telecharge
  // que les favicons manquants -> boot leger meme avec beaucoup de trackers. Le bouton
  // "Rafraichir les logos" permet un refetch force a la demande. On laisse un petit
  // delai pour ne pas concurrencer le refresh des stats au tout debut.
  setTimeout(() => {
    refreshAllLogos(listTrackerDefinitionFiles(), false)
      .then(results => {
        const missing = results.filter(r => !r.ok).map(r => r.id);
        if (missing.length > 0) {
          console.log(`[Logos] Sans favicon auto (deposer un fichier dans config/logos/<id>.png) : ${missing.join(', ')}`);
        }
      })
      .catch(() => { /* best-effort */ });
  }, 30_000);

  // Synchro automatique des clients BitTorrent (beta) au demarrage. betaQbitStats etant
  // en memoire, la liste est vide a chaque restart tant qu'aucune synchro manuelle n'a
  // tourne. On la repeuple automatiquement, sans bloquer le boot et en best-effort. Petit
  // delai pour ne pas concurrencer le refresh des stats trackers au tout debut.
  setTimeout(() => {
    const enabledClients = loadBetaSettings().qbitClients.filter(client => client.enabled);
    if (enabledClients.length === 0) {
      return;
    }
    betaLog(`synchro automatique au demarrage: ${enabledClients.length} client(s) actif(s)`);
    refreshBetaQbitStats()
      .then(stats => {
        const torrentCount = stats.reduce((sum, item) => sum + item.torrentCount, 0);
        betaLog(`synchro automatique terminee: ${torrentCount} torrent(s), ${stats.length} hote(s)`);
      })
      .catch(err => betaWarn(`synchro automatique au demarrage KO - ${err instanceof Error ? err.message : String(err)}`));
  }, 15_000);

  startScheduler();
}
