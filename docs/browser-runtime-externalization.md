# Externaliser le runtime navigateur

## Objectifs

- Réduire autant que possible le poids de l'image principale `tracker-dashboard`.
- Garder les mises à jour aussi simples qu'aujourd'hui pour l'utilisateur final.
- Ne jamais demander aux utilisateurs existants de repartir de zéro.
- Préserver le volume `./config`, la base SQLite, les trackers, cookies, TOTP, proxies, paramètres et profils navigateur existants.
- Ne pas casser les trackers en mode navigateur.
- Ne pas imposer Playwright, Chromium ou CloakBrowser aux utilisateurs qui n'en ont pas besoin.
- Rendre l'état du runtime navigateur clair dans la WebUI : absent, installé, version, à jour, erreur.

## Problème actuel

L'image principale embarque actuellement :

- l'application Node ;
- les dépendances runtime ;
- Playwright ;
- Chromium / Chrome Headless Shell / FFmpeg ;
- les dépendances système installées par `playwright install --with-deps chromium` ;
- `curl-impersonate` ;
- CloakBrowser et son binaire.

Résultat : l'image approche 3 Go. C'est trop lourd pour une fonctionnalité qui n'est nécessaire que pour certains trackers.

## Principe cible

Découper le runtime navigateur de l'application principale.

Image principale :

- contient seulement l'app Node, les dépendances HTTP, la logique métier et éventuellement `curl-impersonate` si le poids reste acceptable ;
- ne contient pas Chromium ;
- ne contient pas CloakBrowser ;
- continue à se mettre à jour comme aujourd'hui via `ghcr.io/tracker-dashboard/tracker-dashboard:latest`.

Runtime navigateur externe :

- image dédiée ou service optionnel ;
- contient Playwright/Chromium ;
- contient éventuellement CloakBrowser ;
- expose une API interne appelée par `tracker-dashboard` uniquement quand un tracker nécessite `mode: browser`.

## Modèle retenu

- fournir le runtime navigateur dans une image/service séparé ;
- le lancer seulement si nécessaire ;
- le mettre à jour séparément via Dockge/Watchtower/Unraid comme n'importe quel container ;
- permettre à `tracker-dashboard` de vérifier sa présence et ses versions.

## Compatibilité et migration

La migration doit être transparente pour les installations existantes.

Contraintes fortes :

- aucun reset utilisateur ;
- aucun changement obligatoire du volume existant `./config:/app/config` ;
- aucune perte de base SQLite ;
- aucune perte de trackers configurés ;
- aucune perte de cookies, TOTP, proxies ou paramètres ;
- aucune perte des profils navigateur persistants déjà présents dans `config/browser-profile`;
- même URL WebUI et même port principal `3000`;
- même image principale `ghcr.io/tracker-dashboard/tracker-dashboard:latest` pour les usages sans navigateur externe.

Le service navigateur externe ne doit pas devenir propriétaire du SQL. La source de vérité reste l'application principale.

Règle d'architecture :

- `tracker-dashboard` lit et écrit SQLite comme aujourd'hui ;
- `tracker-dashboard` prépare le payload nécessaire à l'exécution navigateur ;
- `tracker-dashboard-browser` exécute l'action navigateur et renvoie le résultat ;
- `tracker-dashboard-browser` ne modifie pas les réglages, les trackers, les credentials ou les proxies en base ;
- si un accès aux profils persistants est nécessaire, les deux services partagent le même volume `./config:/app/config`.

Les utilisateurs existants doivent pouvoir migrer ainsi :

1. mettre à jour `tracker-dashboard` comme d'habitude ;
2. constater que les trackers HTTP continuent de fonctionner ;
3. voir dans la WebUI si un runtime navigateur externe est requis pour certains trackers ;
4. ajouter le service `tracker-dashboard-browser` au compose seulement s'ils utilisent des trackers `mode: browser` ;
5. conserver automatiquement les sessions et profils existants via `config/browser-profile`.

Si le runtime navigateur externe est absent, l'application principale doit rester utilisable. Seules les actions nécessitant un navigateur doivent échouer avec un message clair.

## Architecture recommandée

### 1. Service principal léger

`tracker-dashboard`

- garde le port `3000`;
- garde le volume `./config:/app/config`;
- garde la compatibilité avec les installations actuelles ;
- fonctionne entièrement pour les trackers HTTP et le fast-path `curl-impersonate` si conservé.

### 2. Service navigateur optionnel

`tracker-dashboard-browser`

- image dédiée, par exemple `ghcr.io/tracker-dashboard/tracker-dashboard-browser:latest`;
- expose uniquement une API interne, par exemple `3001`;
- aucun port public obligatoire ;
- partage le volume de configuration si nécessaire pour les profils persistants :

```yaml
services:
  tracker-dashboard:
    image: ghcr.io/tracker-dashboard/tracker-dashboard:latest
    container_name: tracker-dashboard
    restart: always
    ports:
      - "3000:3000"
    environment:
      BROWSER_RUNTIME_URL: "http://tracker-dashboard-browser:3001"
    volumes:
      - ./config:/app/config

  tracker-dashboard-browser:
    image: ghcr.io/tracker-dashboard/tracker-dashboard-browser:latest
    container_name: tracker-dashboard-browser
    restart: unless-stopped
    volumes:
      - ./config:/app/config
```

Pour rester simple, documenter deux modes :

- installation simple : un seul container, sans navigateur externe ;
- installation complète : deux containers, nécessaire pour les trackers `mode: browser`.

## API du runtime navigateur

Prévoir une petite API HTTP interne.

Endpoints minimum :

- `GET /health`
- `GET /version`
- `POST /fetch`
- `POST /reset-profile`
- `POST /close-session`
- `POST /close-all`

`GET /version` doit retourner par exemple :

```json
{
  "ok": true,
  "runtime": "tracker-dashboard-browser",
  "playwright": "1.61.0",
  "chromiumExecutable": "/ms-playwright/...",
  "chromiumVersion": "149.0.7827.55",
  "cloakbrowser": {
    "available": true,
    "version": "..."
  }
}
```

`POST /fetch` doit recevoir les éléments nécessaires à l'équivalent actuel de `fetchWithBrowser` :

- tracker config utile ;
- credentials ;
- cookies ;
- proxy résolu ou config proxy ;
- moteur demandé : `chromium` ou `cloak` ;
- timeout ;
- identifiant tracker.

Réponse attendue :

```json
{
  "ok": true,
  "url": "https://...",
  "html": "...",
  "extraHtml": "...",
  "authConfirmed": true,
  "engine": "chromium"
}
```

## Points de code à modifier

### `src/browserFetcher.ts`

Aujourd'hui, ce fichier importe directement Playwright :

```ts
import { chromium, type BrowserContext, type Page } from 'playwright';
```

Il lance ensuite :

- `chromium.launchPersistentContext(...)`
- `chromium.launch(...)`
- éventuellement `cloak.launchPersistentContext(...)`

À faire :

- introduire une abstraction `BrowserRuntime`;
- garder un backend local temporaire si Playwright est encore présent ;
- ajouter un backend distant qui appelle `BROWSER_RUNTIME_URL`;
- faire de `fetchWithBrowser(...)` un appel au runtime distant quand `BROWSER_RUNTIME_URL` est défini ;
- retourner une erreur claire si un tracker navigateur est demandé mais que le runtime externe est absent.

Message utilisateur attendu :

> Runtime navigateur non disponible. Ajoutez le service tracker-dashboard-browser ou désactivez les trackers en mode navigateur.

### `src/server.ts`

Il existe déjà un réglage :

- `GET /api/settings/browser-engine`
- `POST /api/settings/browser-engine`

À compléter :

- `GET /api/browser-runtime/status`
- affichage dans la WebUI : disponible, indisponible, versions, moteur actif ;
- bouton "Vérifier le runtime navigateur" ;
- lien vers la documentation d'installation.

### `Dockerfile`

Objectif image principale :

- retirer `npx playwright install --with-deps chromium`;
- retirer l'installation CloakBrowser ;
- retirer `PLAYWRIGHT_BROWSERS_PATH` si inutilisé ;
- idéalement remplacer la dépendance `playwright` par `playwright-core` seulement si nécessaire côté types/API, ou retirer complètement Playwright de l'image principale si le backend distant couvre tout.

À garder provisoirement :

- `curl-impersonate`, sauf si son poids devient lui aussi problématique.

### Nouveau Dockerfile navigateur

Créer par exemple :

- `Dockerfile.browser`

Contenu :

- base Node compatible ;
- `playwright`;
- `playwright install --with-deps chromium`;
- `cloakbrowser` optionnel ou inclus dans cette image ;
- petit serveur HTTP interne ;
- partage de `/app/config` pour profils et dumps.

## Versions et mises à jour

Le service principal doit pouvoir dire :

- runtime absent ;
- runtime présent ;
- version Playwright attendue ;
- version Playwright installée ;
- Chromium trouvé ;
- CloakBrowser disponible ou non.

Important : ne pas bloquer toute l'application si le runtime navigateur est absent. Seuls les trackers `mode: browser` doivent échouer avec un message clair.

Politique de mise à jour :

- l'image principale suit `tracker-dashboard:latest`;
- l'image navigateur suit `tracker-dashboard-browser:latest`;
- Dockge/Watchtower/Unraid peuvent mettre à jour les deux images séparément ;
- la WebUI peut signaler une différence de version, mais ne doit pas auto-puller une image Docker sans consentement explicite.

## Sécurité

- Ne pas exposer le runtime navigateur sur Internet.
- Idéalement ne pas publier son port côté host.
- L'app principale doit l'appeler via le réseau Docker interne.
- Ajouter un token partagé optionnel si le runtime peut être exposé par erreur :
  - `BROWSER_RUNTIME_TOKEN`
  - header `X-Browser-Runtime-Token`
- Ne jamais envoyer les secrets tracker dans les logs.

## Plan de migration conseillé

1. Ajouter le runtime distant sans retirer immédiatement le runtime local.
2. Ajouter la WebUI de statut.
3. Ajouter `Dockerfile.browser` et le compose optionnel.
4. Basculer les trackers navigateur vers le runtime distant si `BROWSER_RUNTIME_URL` est défini.
5. Une fois validé, alléger l'image principale en retirant Chromium/CloakBrowser.
6. Mettre à jour README et exemples Dockge/Unraid.

## Critères d'acceptation

- L'image principale ne contient plus `/ms-playwright`.
- L'image principale ne préinstalle plus CloakBrowser.
- Les trackers HTTP fonctionnent sans service navigateur.
- Les trackers `mode: browser` affichent une erreur claire si le runtime navigateur est absent.
- Avec `tracker-dashboard-browser`, les trackers navigateur fonctionnent comme avant.
- La WebUI affiche les versions Playwright/Chromium/CloakBrowser disponibles.
- Les mises à jour restent simples : pull/recreate de l'image principale et, si utilisé, pull/recreate de l'image navigateur.
- README mis à jour avec mode simple et mode complet.
