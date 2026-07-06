# Templates Unraid — bêta

Ce dossier fournit trois templates DockerMan pour installer Tracker Dashboard sur Unraid sans Docker Compose :

1. `tracker-dashboard` — application et WebUI ;
2. `tracker-dashboard-browser` — runtime Playwright/Chromium/CloakBrowser requis par les trackers en mode navigateur ;
3. `tracker-dashboard-flaresolverr` — repli anti-bot facultatif.

> [!IMPORTANT]
> Ces templates sont en phase bêta. Nous recherchons des retours d'utilisateurs Unraid avant de proposer une publication dans Community Applications.

## Installation

Depuis le terminal Unraid, téléchargez puis examinez le script :

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Tracker-Dashboard/tracker-dashboard/main/unraid/install-templates.sh \
  -o /tmp/install-tracker-dashboard-templates.sh
cat /tmp/install-tracker-dashboard-templates.sh
sh /tmp/install-tracker-dashboard-templates.sh
```

Dans **Docker → Add Container**, sélectionnez et appliquez les templates dans cet ordre :

1. `tracker-dashboard` ;
2. `tracker-dashboard-browser` ;
3. `tracker-dashboard-flaresolverr`.

Les deux sidecars utilisent `container:tracker-dashboard` : ils partagent le réseau du conteneur principal. Les ports internes `3001` et `8191` ne sont donc pas exposés sur le réseau local. Le runtime navigateur partage également le même dossier appdata `/app/config`.

## Ordre de démarrage

Dans l'onglet **Docker** :

1. déverrouillez la liste avec le cadenas ;
2. placez les conteneurs dans l'ordre `tracker-dashboard`, `tracker-dashboard-browser`, `tracker-dashboard-flaresolverr` ;
3. activez **AutoStart** pour les trois ;
4. en vue avancée, ajoutez si nécessaire une attente de quelques secondes après `tracker-dashboard`.

Unraid démarre les conteneurs AutoStart dans l'ordre affiché et permet d'ajouter un délai entre eux : [documentation Unraid](https://docs.unraid.net/fr/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/).

Après une recréation ou une mise à jour du conteneur principal, recréez les deux sidecars s'ils ne rejoignent plus son espace réseau.

## Vérification

Depuis le terminal Unraid :

```bash
docker ps --filter name=tracker-dashboard
docker exec tracker-dashboard curl -fsS http://127.0.0.1:3001/health
docker exec tracker-dashboard curl -fsS http://127.0.0.1:8191/health
```

Le runtime navigateur doit répondre `{"ok":true}`. FlareSolverr doit renvoyer une réponse HTTP valide.

## Retours recherchés

Merci d'ouvrir un [retour Unraid](https://github.com/Tracker-Dashboard/tracker-dashboard/issues/new?title=%5BUnraid%5D%20Retour%20sur%20les%20templates) en indiquant :

- la version d'Unraid ;
- l'architecture et le matériel ;
- si les trois templates s'installent sans modification ;
- si l'ordre AutoStart fonctionne après un redémarrage de l'array ;
- le résultat des commandes de vérification ;
- toute correction nécessaire dans les chemins, le réseau ou les libellés.

N'incluez jamais d'identifiants de trackers, cookies, secrets TOTP ou tokens dans le retour.
