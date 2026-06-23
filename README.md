<p align="center">
  <img src="public/logo.png" alt="Tracker Dashboard" width="260">
</p>

> **Tu l'utilises ? Tu l'aimes ? [⭐ Mets une étoile !](https://github.com/Tracker-Dashboard/tracker-dashboard/stargazers)** — ça prend deux secondes.

> [!IMPORTANT]
> Le projet est porté par l'organisation GitHub [Tracker-Dashboard](https://github.com/Tracker-Dashboard), en collaboration avec [Zup](https://github.com/Gusdezup) ([Autovisit-Web](https://github.com/Gusdezup/Autovisit-Web)).
>
> Les pull requests sont les bienvenues. Le projet continue d'évoluer (nouveaux sites, statistiques, interface).

> [!WARNING]
> Lors d'un rafraîchissement général ou du premier lancement, certains trackers peuvent temporairement afficher une erreur ou prendre du temps à se mettre à jour. Lancez si besoin une mise à jour individuelle du tracker concerné.
>
> Les lectures via navigateur headless sont plus lourdes que les lectures HTTP. L'application limite la concurrence, applique un timeout par tracker, sert le cache au démarrage et utilise curl-impersonate quand c'est possible.

# Tracker Dashboard

Tracker Dashboard est une WebUI pour suivre les statistiques de vos trackers BitTorrent : upload, download, ratio, buffer, points bonus, torrents en seed, MP non lus… selon les capacités de chaque site. Elle gère les identifiants, un proxy (HTTP/HTTPS/SOCKS/SSH), des connexions automatiques planifiées, l'historique en SQLite, et compare vos stats aux torrents réellement présents dans vos clients BitTorrent.

Au premier accès, l'application demande de créer le compte administrateur de la WebUI.

**Export Prometheus + Grafana** : endpoint `/metrics` (protégé par token via `METRICS_TOKEN`) exposant les stats des trackers activés (`tracker_*`) et des clients BitTorrent (`tracker_qbit_*`). Dashboard Grafana JSON dans `grafana/dashboard.json` — voir [grafana/README.md](grafana/README.md).

## Changements récents

- **Image principale allégée** : Playwright/Chromium/CloakBrowser sont sortis dans l'image parallèle `tracker-dashboard-browser`. Le compose principal ne change pas ; la WebUI affiche l'état, les versions, la commande de lancement et les alertes de mise à jour.
- **Plusieurs comptes par tracker** : duplication d'un tracker, noms d'affichage personnalisables, regroupement sous le site, et attribution des torrents par passkey entre comptes.
- Refonte de la navigation : barre latérale unique, thème clair/sombre/système, nouveau logo.
- Fiches de trackers enrichies : statut clair, courbes d'évolution UP/DL/ratio (buffer en option), erreurs en cours / récentes / historique.
- Menu **Calendrier** des refreshs (OK/KO par jour, accès à la config en cas de KO).
- **Clients BitTorrent** : comparaison aux torrents locaux + **rafraîchissement automatique configurable par client** (jours/heures).
- Notifications réorganisées (canaux, globales, par tracker) — Discord, Apprise ou e-mail ; détection des MP non lus.
- Métriques Prometheus des clients BitTorrent (`tracker_qbit_*`).
- Double authentification 2FA (TOTP) par tracker.
- Proxy SSH (mot de passe ou clé privée), en plus de HTTP/HTTPS/SOCKS.
- Option moteur navigateur furtif CloakBrowser, en alternative à Chromium.
- Lecture rapide via curl-impersonate quand c'est possible (évite Chromium).
- Cookies de session par tracker (sites à CAPTCHA / Cloudflare).

## Interface

La navigation se fait depuis la barre latérale gauche :

- **Dashboard** : vue d'ensemble des trackers (cartes ou lignes, bascule sous le menu). Chaque carte peut porter un « incident connu » et une note libre.
- **Graphiques** : Global (UP/DL/seedtime agrégés), Évolution (par tracker ou « Tous »), comparaison multi-trackers (sélection libre des trackers), Totaux par tracker. Chaque graphe a un sélecteur de période et une plage de dates Du/Au.
- **Calendrier** : calendrier des refreshs (OK/KO par jour) ; un tracker en KO renvoie vers sa configuration.
- **Trackers activés** : accordéon listant les trackers actifs ; un clic ouvre la **fiche** du tracker.
- **Configuration** : *Ajouter un tracker* (sites non activés), *Configurer les actifs*, *Clients BitTorrent*, *Notifications* (Canaux, Notifications globales, Par tracker), *Proxies*, *Fréquence d'auto visite*.
- En bas : *Synchroniser les sites*, horodatage de dernière mise à jour, bascule de thème **Clair / Sombre / Système**, déconnexion.

### Fiche d'un tracker

- En-tête : logo, nom, lien vers le site, badge de statut (OK / cassé / données anciennes).
- Stats actuelles : ratio, buffer, UP, DL, seed, torrents client.
- **Courbes d'évolution** : Volumes (UP / DL, buffer en option) et Ratio, sur 7 jours / 30 jours / Tout ou une plage Du/Au.
- **Comment ce tracker est lu** : mode de lecture (login auto / cookie collé / captcha), dernière lecture réussie, cookie et 2FA définis ou non.
- **Erreurs** : erreur en cours, erreurs récentes (7 jours), historique complet.
- **Notifications configurées** : reprend les notifications du menu Notifications applicables au tracker (sinon « Aucune »).
- **Torrents liés** : torrents détectés dans vos clients BitTorrent pour ce tracker (état, taille, UP/DL/ratio), avec import des associations non reconnues.

## Cookies de session (sites à CAPTCHA / Cloudflare)

Certains trackers protègent leur login par un CAPTCHA ou un challenge anti-bot (Cloudflare Turnstile…). Le navigateur headless ne peut pas les résoudre. Pour ces sites, fournissez directement un **cookie de session** : connectez-vous dans votre navigateur, exportez le cookie, puis collez-le dans **Configuration → Configurer les actifs → (le tracker) → Options avancées → Cookie de session**. Le dashboard l'injecte avant chaque lecture et saute la page de login.

Trois formats auto-détectés :
- fichier **Netscape `cookies.txt`** ;
- export **JSON** d'une extension type *Cookie-Editor* ;
- chaîne brute `nom=valeur; nom2=valeur2` copiée depuis les DevTools.

Extensions pratiques : [cookies-txt](https://github.com/hrdl-github/cookies-txt), [Cookie-Editor](https://cookie-editor.com/), [Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY).

Le cookie est optionnel et propre à chaque tracker ; il finit par expirer, il suffit alors d'en recoller un frais.

## Double authentification (2FA / TOTP)

Pour les trackers en 2FA basée sur le temps (TOTP), le dashboard génère lui-même le code à 6 chiffres. Renseignez le **secret 2FA** (clé base32 affichée à l'activation, ex. `JBSWY3DPEHPK3PXP`) dans **Options avancées → Secret 2FA (TOTP)** du tracker.

- Secret stocké côté serveur, jamais renvoyé en clair par l'API.
- Code calculé en local (RFC 6238, HMAC-SHA1, 6 chiffres, fenêtre 30 s).
- **Flux en deux étapes** (Laravel Fortify / UNIT3D) : le code est soumis automatiquement sur la page de challenge. Pris en charge en HTTP, curl-impersonate et navigateur.
- **Flux en une étape** : `login.otpField` ou placeholder `{{otp}}` dans le corps de login.

Laissez le champ vide pour les trackers sans 2FA.

## Plusieurs comptes par tracker

Pour suivre **plusieurs comptes sur un même site**, dupliquez un tracker : dans **Configuration → Configurer les actifs → (le tracker)**, cliquez sur **Dupliquer**. Un nouveau compte « (2) » est créé, prêt à recevoir ses identifiants.

- Le duplicata reprend la **même mécanique de login** que le tracker d'origine et **hérite automatiquement** des corrections de login publiées par la suite.
- **Identifiants, cookie, 2FA, profil navigateur, statistiques, planning et notifications sont indépendants** entre comptes.
- **Nom d'affichage modifiable** : sur la fiche de configuration de chaque compte, champ **Nom d'affichage** + **Renommer** (ex. « C411 », « C411 Alex », « C411 Ishem »).
- Dans la barre latérale (« Configurer les actifs » et « Trackers activés »), les comptes d'un même site sont **regroupés sous le nom du site**, dépliable.
- Un compte dupliqué est **supprimable** (bouton **Supprimer** sur sa fiche) ; le tracker intégré d'origine, lui, ne peut être que désactivé.

### Attribution des torrents par passkey

Quand un site a plusieurs comptes, les torrents de vos clients BitTorrent sont ventilés par **passkey** (celle présente dans l'URL d'annonce). Sur la **fiche** d'un compte, la section **Attribution des annonces** liste les passkeys détectées (affichées masquées) ; attribuez chacune au bon compte. Les torrents correspondants — et leurs statistiques — suivent alors le compte choisi. Avec un seul compte, rien ne change : l'attribution automatique par hôte reste utilisée.

## Captures d'écran

> Les captures ci-dessous illustrent le principe (données factices). L'interface a évolué depuis et ces captures seront mises à jour.

![Dashboard](screens/1.png)
![Configuration des trackers](screens/2.png)
![Proxy et options](screens/3.png)

## Connexions automatiques

La planification se règle dans **Configuration → Fréquence d'auto visite** :

- **Planification globale** : trois modes — toutes les *X* heures, tous les *X* jours à heure fixe, ou certains jours de la semaine. Chaque cycle visite les trackers actifs disposant d'identifiants.
- **Fréquences individuelles** : par tracker, on peut suivre la planification globale, la désactiver, ou fixer un intervalle propre (en heures).
- **Synchroniser les sites** (bas de la barre latérale) lance un rafraîchissement manuel immédiat.

En cas de timeout ponctuel non marqué comme incident, les dernières données valides restent affichées avec un indicateur, puis le dashboard retente automatiquement 3 fois toutes les 10 minutes, puis 3 fois toutes les heures, avant la prochaine connexion planifiée.

## Clients BitTorrent

Dans **Configuration → Clients BitTorrent**, ajoutez un ou plusieurs clients **qBittorrent** ou **ruTorrent/rTorrent** (URL d'API, identifiants). Le dashboard agrège les torrents par hôte d'annonce et les rapproche de vos trackers, ce qui alimente la fiche de chaque tracker.

- Un lien **Ouvrir** mène à l'interface du client.
- Chaque client a un champ **Auto (j / h)** : intervalle de rafraîchissement automatique (0 = désactivé). Les données sont aussi exposées à Prometheus (`tracker_qbit_*`).

## Notifications

Configurables dans **Configuration → Notifications**, en trois volets :

- **Canaux** : destinations **Discord**, **Apprise** ou **e-mail**.
- **Notifications globales** : échecs, succès, rétablissement après échec, statistiques, MP non lus.
- **Par tracker** : réglages spécifiques (échecs, succès, stats, MP, seuils de ratio / buffer / ancienneté de session) qui priment sur les réglages globaux.

## Sécurité proxy

Par défaut, les connexions aux trackers sont **bloquées si aucun proxy n'est actif**. Pour autoriser les connexions, il faut soit :
- configurer et activer un proxy,
- cocher explicitement l'option de connexion directe sans proxy (utile si le conteneur sort déjà via un VPN au niveau du réseau Docker).

Cette sécurité s'applique aussi au premier lancement.

Types pris en charge : **HTTP**, **HTTPS**, **SOCKS4**, **SOCKS5** et **SSH** — en proxy global comme en override par tracker.

### Proxy SSH

Avec le type **SSH**, le dashboard ouvre un tunnel SSH (SOCKS5 local adossé au forwarding dynamique) pour sortir via l'IP d'un serveur auquel vous avez un accès SSH.

- Renseignez **hôte / port / utilisateur**, puis **un mot de passe OU une clé privée** (PEM OpenSSH, passphrase acceptée).
- Les secrets sont stockés côté serveur, jamais renvoyés en clair (masqués).
- Le bouton **Tester** établit le tunnel et vérifie l'IP de sortie.

## Runtime navigateur

Le navigateur (Playwright/Chromium/CloakBrowser) est externalisé dans l'image `ghcr.io/tracker-dashboard/tracker-dashboard-browser:latest`. L'image principale reste allégée, sans modifier le `docker-compose.yml` existant.

Lancez le runtime navigateur en parallèle du conteneur principal :

```bash
docker run -d \
  --name tracker-dashboard-browser \
  --restart unless-stopped \
  --network container:tracker-dashboard \
  --volumes-from tracker-dashboard \
  ghcr.io/tracker-dashboard/tracker-dashboard-browser:latest
```

Avec `--network container:tracker-dashboard`, Tracker Dashboard joint automatiquement le runtime sur `http://127.0.0.1:3001`. Avec `--volumes-from tracker-dashboard`, les profils navigateur et cookies restent sur le même volume `./config`. Le service navigateur ne touche pas la base : l'app principale reste la source de vérité et lui transmet ce qu'il faut par appel interne.

Si le runtime navigateur est absent, les trackers en `mode: browser` affichent une erreur claire et la WebUI donne la commande d'installation. L'état et les versions (Playwright/Chromium/CloakBrowser) sont visibles dans **Proxies → Moteur navigateur → Runtime navigateur**. La WebUI signale aussi si le runtime navigateur ne correspond pas à la révision de l'application.

### Moteur navigateur (CloakBrowser)

Les lectures en mode navigateur utilisent **Chromium** (Playwright) par défaut. Une option (panneau Proxies → Moteur navigateur) bascule sur **[CloakBrowser](https://github.com/CloakHQ/CloakBrowser)**, un Chromium modifié pour présenter une empreinte de vrai navigateur (TLS, fingerprint) et franchir davantage de protections anti-bot. S'il est indisponible, l'app repart automatiquement sur Chromium.

## Lecture rapide (curl-impersonate)

**[curl-impersonate](https://github.com/lexiforest/curl-impersonate)** usurpe l'empreinte TLS/HTTP2 d'un vrai Chrome et franchit le filtrage anti-bot passif sans navigateur. Le dashboard l'utilise automatiquement pour le login HTTP complet et pour les trackers navigateur disposant d'un cookie. Le repli est automatique (aucune lecture cassée). Réglage : panneau Proxies → Moteur navigateur → *Lecture rapide* (activé par défaut).

## User-Agent aléatoire

Rotation automatique de User-Agents (paquet `top-user-agents`) pour les nouvelles sessions HTTP et contextes navigateur.

## Sites intégrés & ajout d'un site

Une trentaine de définitions de sites sont fournies dans `config/trackers/*.json` (un fichier JSON par site : connexion, page à lire, champs à extraire). Les nouvelles définitions sont détectées au démarrage et proposées à l'activation.

Pour préparer l'ajout d'un site, fournissez idéalement : nom, URL de base, URL de login (et méthode particulière éventuelle), URL de la page de stats, son HTML une fois connecté, les valeurs à récupérer, et le CMS éventuel (UNIT3D, Gazelle, Luminance…).

Champs habituels :

| Champ | Usage |
|---|---|
| `uploadedBytes` | Upload |
| `downloadedBytes` | Download |
| `ratio` | Ratio |
| `bufferBytes` | Buffer |
| `seeding` | Torrents en seed |
| `seedBonus` | Points bonus |
| `tokens` | Jetons / tokens |
| `unreadMessages` | MP non lus |

Le ratio peut être calculé depuis upload/download s'il n'est pas exposé ; idem pour le buffer.

### Format simplifié d'une définition

```json
{
  "id": "example",
  "name": "Example Tracker",
  "baseUrl": "https://example.org",
  "enabled": false,
  "login": {
    "url": "login",
    "method": "POST",
    "contentType": "form",
    "body": { "username": "{{username}}", "password": "{{password}}" },
    "failurePatterns": ["login"]
  },
  "fetch": {
    "url": "account",
    "mode": "http",
    "responseType": "html",
    "fields": {
      "uploadedBytes": {
        "regex": "Upload[^0-9]*(?<value>[0-9.,]+\\s*(?:GB|GiB|TB|TiB))",
        "transform": "bytes"
      }
    }
  }
}
```

### Transformations disponibles

| Transformation | Effet |
|---|---|
| `bytes` | Convertit `1.5 GB`, `800 MiB`, `2 To`, `276 Gio`… en octets |
| `number` | Nombre décimal |
| `integer` | Entier |
| `string` | Conserve le texte |

## Remerciements

- [Autovisit](https://github.com/Gusdezup/Autovisit) — idée de la prise en charge du 2FA (TOTP).
- [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) — moteur Chromium furtif proposé en option.
- Et tous les contributeurs qui partagent des définitions de trackers.
