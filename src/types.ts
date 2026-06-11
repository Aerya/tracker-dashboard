// ─── Config (trackers.json) ───────────────────────────────────────────────────

/** Étape optionnelle avant le login — sert à récupérer un token CSRF */
export interface PreLoginStep {
  url: string;
  /** Extractions via regex avec groupe nommé (?<value>...) */
  extract: Record<string, { regex: string }>;
  includeHiddenInputs?: boolean;
}

export interface LoginConfig {
  url: string;
  method?: 'POST' | 'GET';
  /** 'form' = application/x-www-form-urlencoded  |  'json' = application/json */
  contentType?: 'form' | 'json';
  /**
   * Corps de la requête de login.
   * Placeholders supportés : {{username}}, {{password}}, {{otp}} (code TOTP),
   * et {{nomClé}} pour les valeurs extraites dans preStep (ex: {{_csrf}}).
   */
  body: Record<string, string>;
  /**
   * Nom du champ de formulaire recevant le code 2FA (TOTP).
   * Si défini et qu'un secret TOTP est enregistré pour le tracker, le code
   * courant y est injecté automatiquement (mode HTTP et navigateur).
   * Ex UNIT3D : "two_step_code" ; autres : "code", "otp", "totp", "mfa".
   */
  otpField?: string;
  /** Étape optionnelle pour récupérer un CSRF token avant de poster les credentials */
  preStep?: PreLoginStep;
  /**
   * Chaînes HTML dont la présence indique un échec de login.
   * Vérifiées après le login ET après chaque fetch (session expirée).
   */
  failurePatterns: string[];
  /**
   * Si true : ne JAMAIS soumettre le formulaire de login automatiquement.
   * On s'appuie uniquement sur le cookie de session injecte. Indispensable pour
   * les sites qui plafonnent/bloquent les logins automatises (ex: MyAnonamouse).
   */
  cookieOnly?: boolean;
}

export interface FieldExtractor {
  // JSON : chemin dot-notation  ex: "response.stats.uploaded"
  path?: string;
  // HTML : regex avec groupe nommé (?<value>...)
  regex?: string;
  transform?: 'bytes' | 'number' | 'integer' | 'string';
}

export interface FetchStep {
  url: string;
  mode?: 'http' | 'browser';
  responseType: 'json' | 'html';
  fields: Record<string, FieldExtractor>;
}

export interface TrackerConfig {
  id: string;
  name: string;
  baseUrl: string;
  enabled?: boolean;
  /** Tracker sans systeme de ratio (HD-Only, Nostradamus, etc.) */
  ratioless?: boolean;
  /** Profil curl-impersonate autorise pour le login HTTP complet. */
  curlBinary?: 'curl_firefox133' | 'curl_firefox135';
  login: LoginConfig;
  fetch: FetchStep;
  dashboard?: {
    byteUnit?: 'binary' | 'decimal';
  };
}

export interface AppConfig {
  refreshInterval?: number; // minutes, défaut 15
  trackers: TrackerConfig[];
}

/** credentials.json — séparé de trackers.json, à gitignorer */
export type Credentials = Record<string, { username: string; password: string }>;

// ─── Runtime ─────────────────────────────────────────────────────────────────

export interface TrackerStats {
  id: string;
  name: string;
  trackerUrl?: string;
  status: 'ok' | 'error';
  error?: string;
  /** Resultat d'un ping HTTP sur baseUrl avec motif si injoignable */
  siteReachability?: {
    reachable: boolean;
    /**
     * - 'network'       : echec reseau / TLS / proxy / DNS / timeout
     * - 'http_5xx'      : serveur a repondu mais avec un 5xx (souvent IP bannie ou panne)
     * - 'http_forbidden': 403 / 451 (acces refuse - IP bloquee, geo-block, etc.)
     */
    reason?: 'network' | 'http_5xx' | 'http_forbidden';
    statusCode?: number;
  };
  lastUpdated: string;
  lastLoginAt?: string;
  byteUnit: 'binary' | 'decimal';
  fields: Record<string, string | number>;
  /** Incident "connu" manuellement signale par l'utilisateur (auto-clear sur status=ok) */
  incident?: { acknowledged: boolean; note: string };
  /** Dernieres donnees OK conservees apres un timeout ponctuel du refresh courant. */
  stale?: {
    reason: 'timeout';
    error: string;
    failedAt: string;
    siteReachability?: TrackerStats['siteReachability'];
  };
}
