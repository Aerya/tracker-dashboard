<p align="center">
  <img src="public/logo.png" alt="Tracker Dashboard" width="260">
</p>

> **Tu l'utilises ? Tu l'aimes ? [⭐ Mets une étoile !](https://github.com/Tracker-Dashboard/tracker-dashboard/stargazers)** — ça prend deux secondes.

> [!IMPORTANT]
> Le projet est désormais porté par l'organisation GitHub [Tracker-Dashboard](https://github.com/Tracker-Dashboard).
>
> Tracker Dashboard évolue en collaboration avec [Zup](https://github.com/Gusdezup) afin de réunir Tracker Dashboard et son projet [Autovisit-Web](https://github.com/Gusdezup/Autovisit-Web) au sein d'un projet unifié.
>
> Les pull requests sont les bienvenues. Le projet va évoluer dans les semaines à venir avec l'intégration de davantage de sites et de statistiques.

> [!WARNING]
> Lors d’un rafraîchissement général ou du premier lancement, certains trackers peuvent temporairement afficher une erreur ou prendre du temps à se mettre à jour.
>
> Si besoin, lancez une mise à jour individuelle du tracker concerné.
>
> Les lectures reposant sur le navigateur headless restent plus lourdes que les lectures HTTP classiques. L'application limite donc la concurrence, applique un timeout par tracker et utilise le cache au démarrage ainsi que curl-impersonate quand c'est possible.



# Tracker Dashboard

Tracker Dashboard est une WebUI pour suivre les statistiques de trackers BitTorrent : upload, download, ratio, buffer, points bonus, torrents en seed, selon les fonctionnalités du tracker.
Le projet permet de configurer les trackers actifs, leurs identifiants, un proxy HTTP/HTTPS/SOCKS, des connexions automatiques espacées dans le temps et l'historique des statistiques en SQLite.

Au premier accès, l'application demande de créer le compte administrateur de la WebUI.

Export Prometheus + dashboard Grafana — endpoint `/metrics` (protégé par token via la variable d'env `METRICS_TOKEN`) exposant les stats de tous les trackers activés au format Prometheus. Dashboard Grafana JSON fourni dans `grafana/dashboard.json` (jauges de ratio, courbes upload/download par tracker, bonus points, deltas quotidiens, état OK/HS). Voir [grafana/README.md](grafana/README.md) pour l'installation.


## Changements récents

- Ajout BrokenStones (PR, merci Zlimteck)
- Double authentification 2FA (TOTP) par tracker (merci Autovisit pour l'idée)
- Proxy SSH (mot de passe ou clé privée), en plus de HTTP/HTTPS/SOCKS
- Option moteur navigateur furtif CloakBrowser, en alternative à Chromium
- Lecture rapide via curl-impersonate quand c'est possible (évite Chromium)
- Meilleure identification des trackers en cookie only (captchas, Cloudflare...)
- Ajout option refresh 6 et 12h
- Allègement restart du Docker : données < 24h servies en priorité
- Option ProxyLess pour certains trackers (MaM notamment)
- Cookies de sessions pour tous les trackers, pour éviter les complications (captchas, antibots etc) lors des logins via le browser headless
- Ajout vue Lignes en sus de Cartes
- Ajout CrazySpirits, Seedpool et Tigers-DL (merci jack)
- Ajout "Incident connu" + note libre sur les cartes. Inspiré par LaCale vu le site en ligne mais login HS depuis le 19 mai 2026
- Ajout TorrentLeech (merci NohamR)
- Check de joignabilité en cas d'erreur de login
- Export Prometheus + dashboard Grafana : endpoint `/metrics` protégé par token (`METRICS_TOKEN`) et dashboard JSON prêt à importer dans `grafana/`.


## Cookies de session (sites à CAPTCHA / Cloudflare)

Certains trackers protègent leur page de connexion par un CAPTCHA ou un challenge anti-bot (Cloudflare Turnstile, etc.). Le navigateur headless intégré ne peut pas les résoudre automatiquement, et le login échoue.

Pour ces sites, on peut court-circuiter le login en fournissant directement un **cookie de session** : connectez-vous au tracker dans votre navigateur habituel, exportez le cookie, puis collez-le dans le dashboard (liste des trackers → tracker concerné → **Options avancées** → **Cookie de session**). Le dashboard l'injecte dans le navigateur headless avant chaque lecture, ce qui évite complètement la page de login.

Trois formats sont acceptés (auto-détectés) :
- fichier **Netscape `cookies.txt`** (le plus simple) ;
- export **JSON** d'une extension type *Cookie-Editor* ;
- chaîne d'en-tête brute `nom=valeur; nom2=valeur2` copiée depuis les DevTools (F12 → Application/Stockage → Cookies).

Quelques extensions pratiques pour exporter les cookies :
- [cookies-txt](https://github.com/hrdl-github/cookies-txt) (export au format Netscape `cookies.txt`)
- [Cookie-Editor](https://cookie-editor.com/) (export JSON)
- [Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY)

Le cookie est optionnel et propre à chaque tracker : laissez le champ vide pour les sites qui se connectent normalement. Un cookie de session finit par expirer (de quelques heures à plusieurs semaines selon le site) ; il suffit alors d'en recoller un frais.


## Double authentification (2FA / TOTP)

Pour les trackers protégés par une authentification à deux facteurs basée sur le temps (TOTP, type Google Authenticator / Authy), le dashboard peut générer lui-même le code à 6 chiffres à chaque connexion.

Renseignez le **secret 2FA** (la clé base32 affichée à côté du QR code lors de l'activation du 2FA, ex. `JBSWY3DPEHPK3PXP`) dans : liste des trackers → tracker concerné → **Options avancées** → **Secret 2FA (TOTP)**.

- Le secret est stocké côté serveur et n'est jamais renvoyé en clair par l'API (seul un indicateur de présence est exposé).
- Le code est calculé en local (RFC 6238, HMAC-SHA1, 6 chiffres, fenêtre de 30 s) ; aucun service externe n'est sollicité.
- **Flux en deux étapes** (Laravel Fortify / UNIT3D) : après le login identifiant + mot de passe, si le tracker redirige vers sa page de challenge 2FA (`two-factor-challenge`), le dashboard y soumet automatiquement le code (champ `code`) avec le CSRF de cette page. Pris en charge dans les trois modes : HTTP (axios), curl-impersonate et navigateur.
- **Flux en une étape** : si le code se saisit dans le formulaire de login lui-même, définissez `login.otpField` (le code y est injecté) ou utilisez le placeholder `{{otp}}` dans le corps de login.
- Si un tracker exige le 2FA mais qu'aucun secret n'est enregistré, l'erreur le précise explicitement.

Laissez le champ vide pour les trackers sans 2FA.


## Captures d'écran

Les captures ci-dessous montrent l'interface avec des données issues du mode Présentation. Les valeurs affichées sont factices et ne reflètent pas des statistiques réelles.

![Dashboard](screens/1.png)

![Configuration des trackers](screens/2.png)

![Proxy et options](screens/3.png)


## Fonctionnement général

L'application lit les définitions disponibles dans `config/trackers/*.json` et les ajoutent à une liste de tracker BitTorrent disponibles pour la configuration.
Chaque définition indique comment se connecter au site, quelle page lire et quelles valeurs extraire.

Depuis la WebUI, on peut :

- activer ou retirer un tracker,
- enregistrer ou réinitialiser les identifiants d'un tracker,
- configurer un proxy HTTP, HTTPS, SOCKS4 ou SOCKS5,
- autoriser explicitement la connexion directe sans proxy si ce Docker passe par un VPN (ou si vous aimez sortir à poual, ce qui est fortément déconseillé),
- lancer un rafraîchissement manuel des statistiques,
- activer une connexion automatique par tracker,
- lui choisir un intervalle : 6h, 12h, 24h, 48h, 7 jours ou 21 jours.

Les données persistantes sont stockées dans SQLite, dans le volume `config` monté.


## Sécurité proxy

Par défaut, les connexions aux trackers sont bloquées si aucun proxy n'est actif.
Pour autoriser les connexions, il faut soit :
- configurer et activer un proxy,
- cocher explicitement l'option de connexion directe sans proxy.
Cette sécurité s'applique aussi au premier lancement du conteneur.

Types de proxy pris en charge : **HTTP**, **HTTPS**, **SOCKS4**, **SOCKS5** et **SSH** — en proxy global comme en override par tracker.

### Proxy SSH

Avec le type **SSH**, le dashboard ouvre une connexion SSH vers le serveur indiqué et route le trafic des trackers à travers un tunnel (un serveur SOCKS5 local adossé au forwarding dynamique SSH). Pratique pour sortir via l'IP d'un serveur auquel on a un accès SSH, sans installer de proxy dédié.

- Renseignez **hôte / port / utilisateur**, puis **un mot de passe OU une clé privée** (PEM OpenSSH). Une passphrase de clé est acceptée si nécessaire.
- Les secrets (mot de passe, clé privée, passphrase) sont stockés côté serveur et ne sont jamais renvoyés en clair par l'API (masqués par des points).
- Le bouton **Tester** établit le tunnel et vérifie l'IP de sortie.


## User-Agent aléatoire

Les connexions utilisent une rotation automatique de User-Agents issue du paquet `top-user-agents`. Il est choisi automatiquement pour les nouvelles sessions HTTP et les nouveaux contextes navigateur.


## Moteur navigateur (CloakBrowser)

Les lectures en mode navigateur utilisent **Chromium** (Playwright) par défaut. Une option dans la WebUI (panneau Proxy → **Moteur navigateur**) permet de basculer sur **[CloakBrowser](https://github.com/CloakHQ/CloakBrowser)**, un Chromium modifié au niveau source pour présenter une empreinte de vrai navigateur (TLS, fingerprint).

Intérêt par rapport au Chromium standard : il franchit davantage de protections anti-bot — notamment certains challenges Cloudflare Turnstile qui se valident automatiquement — donc moins de trackers nécessitant un cookie de session collé à la main. Les performances sont équivalentes (c'est un navigateur complet).

Le moteur est embarqué dans l'image Docker. S'il est indisponible (binaire absent, échec de lancement), l'application repart automatiquement sur Chromium : activer l'option ne peut donc pas casser les lectures.


## Lecture rapide (curl-impersonate)

Beaucoup de trackers filtrent les requêtes sur l'empreinte TLS : un client Node (axios) est repéré comme « non-navigateur » et se voit servir une page anti-bot (Cloudflare, DDoS-Guard…), même avec de bons identifiants. **[curl-impersonate](https://github.com/lexiforest/curl-impersonate)** usurpe l'empreinte TLS/HTTP2 d'un vrai Chrome et franchit ce filtrage passif, sans navigateur.

Le dashboard l'utilise de deux façons, automatiquement :

- **Trackers en mode HTTP** : le login complet (page CSRF → POST identifiants → lecture des stats) est tenté via curl-impersonate, avec un jar de cookies. En cas d'échec ou si le binaire est absent, l'application retombe sur axios.
- **Trackers en mode navigateur** disposant d'un **cookie de session** : une simple requête HTTP impersonée est tentée avant de lancer Chromium. Si la page nécessite du JavaScript (SPA) ou que la session n'est plus valide, l'application retombe sur le navigateur.

Dans tous les cas, le repli est **automatique** : aucune lecture n'est cassée. Le binaire est embarqué dans l'image Docker. L'option se règle dans la WebUI (panneau Proxy → **Moteur navigateur** → *Lecture rapide*), activée par défaut.


## Connexions automatiques

Chaque tracker peut avoir sa propre planification automatique.
La WebUI permet de choisir 24h/48h/7j/21j.
L'application calcule ensuite une prochaine exécution pour chaque tracker. Le bouton `Rafraîchir les statistiques` permet de lancer un rafraîchissement manuel.


En cas de timeout ponctuel non marque comme incident connu, les dernieres donnees valides restent affichees avec un indicateur orange, puis le dashboard retente automatiquement 3 fois toutes les 10 minutes, puis 3 fois toutes les heures, avant d'attendre la prochaine connexion automatique prevue.


## Sites intégrés

Les définitions de sites déjà fournies sont disponibles directement dans :

```text
config/trackers/
```

Chaque fichier JSON correspond à un site et contient sa configuration de connexion, la page à lire et les champs à extraire.

N'hésitez pas à me partager vos définitions, que je les ajoute au Docker.


## Ajouter un nouveau site

Pour ajouter un tracker, il faut créer un fichier JSON dans :

```text
config/trackers/
```

Pour préparer l'ajout d'un site, il faut idéalement fournir :
- le nom du site,
- l'URL de base du site,
- l'URL de la page de login,
- la méthode de login si elle est particulière (combinaison de touches pour accéder au login etc),
- l'URL de la page qui contient les statistiques du compte,
- le code source HTML de cette page une fois connecté,
- les noms exacts des valeurs à récupérer : upload, download, ratio, bonus, buffer, seeding, etc,
- si le site utilise un CMS connu, par exemple UNIT3D, Gazelle, Luminance...

Les champs habituellement exploités par le tableau de bord sont :

| Champ | Usage |
|---|---|
| `uploadedBytes` | Upload |
| `downloadedBytes` | Download |
| `ratio` | Ratio |
| `bufferBytes` | Buffer |
| `seeding` | Torrents en seed |
| `seedBonus` | Points bonus |
| `tokens` | Jetons ou tokens |

Si le ratio n'est pas présent sur le site mais que l'upload et le download sont disponibles, le tableau de bord peut le calculer.
Si le buffer n'est pas fourni par le site, il peut être calculé à partir de l'upload et du download.


## Format simplifié d'une définition

Exemple schématique :

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
    "body": {
      "username": "{{username}}",
      "password": "{{password}}"
    },
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


## Transformations disponibles

| Transformation | Effet |
|---|---|
| `bytes` | Convertit une taille comme `1.5 GB`, `800 MiB`, `2 To`, `276 Gio` en nombre d'octets |
| `number` | Convertit en nombre décimal |
| `integer` | Convertit en entier |
| `string` | Conserve la valeur en texte |


## Remerciements

- [Autovisit](https://github.com/Gusdezup/Autovisit) — pour l'idée de la prise en charge du 2FA (TOTP) côté login.
- [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) — moteur Chromium furtif proposé en option pour mieux passer les protections anti-bot.
