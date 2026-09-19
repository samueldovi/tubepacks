# TubePacks

Jeu d'ouverture de packs de vidéos YouTube françaises : un pack offert toutes les 10 minutes,
collection par joueur, hôtel des ventes entre joueurs, profils publics et console d'administration.
Un worker alimente le jeu en continu (vidéos ≥ 10 000 vues) et rafraîchit vues et j'aime.

```
web/        FastAPI : pages, comptes (Argon2), sessions Redis, packs, enchères, admin
web/lua.py  scripts Lua : pièces et cartes déplacées de façon atomique côté Redis
worker/     moissonneuse : API Invidious / Piped, flux RSS des chaînes, yt-dlp en secours
redis       données persistantes (AOF, volume redis-data)
```

## Le jeu

- **Packs** — 5 cartes. Un pack offert toutes les 10 minutes, jusqu'à 12 en réserve ; au-delà le
  compteur s'arrête. Chaque ouverture rapporte 20 pièces ; un pack supplémentaire coûte 250 pièces.
- **Raretés** — selon les vues de la vidéo, avec des chances volontairement sèches :

  | Carte | Vues | Chance par carte | Recyclage |
  |---|---|---|---|
  | Commune | ≥ 10 000 | 79 % | 5 🪙 |
  | Rare | ≥ 100 000 | 16 % | 30 🪙 |
  | Épique | ≥ 1 M | 4 % | 200 🪙 |
  | Légendaire | ≥ 10 M | 0,9 % | 1 200 🪙 |
  | Mythique | ≥ 100 M | 0,1 % | 6 000 🪙 |

  Une Mythique tombe environ une fois tous les 200 packs. Le tirage se fait entièrement côté
  serveur, sur l'ensemble du catalogue : un joueur ne peut pas restreindre son tirage aux
  vidéos les plus vues.
- **Pièces** — recyclage des doublons (5 à 6 000 pièces selon la rareté, un exemplaire est toujours
  conservé), bonus d'ouverture, ventes à l'hôtel des ventes.
- **Hôtel des ventes** — on met une carte en vente (elle quitte la collection le temps de l'enchère),
  durée 15 min à 24 h. Les pièces d'un enchérisseur sont bloquées et rendues dès qu'il est surenchéri.
  Surenchère minimale +5 %, commission de 5 % au vendeur, et toute mise dans la dernière minute
  prolonge l'enchère d'une minute (anti-snipe). Les enchères se clôturent toutes seules côté serveur.
- **Profil** — avatar, bio, statistiques, progression par rareté, plus belles cartes, classements.
  Les profils des autres joueurs sont consultables depuis le classement.

## Le worker

Le catalogue se remplit tout seul, en quatre moissons par cycle (une minute par défaut) :

1. **Tendances FR** et **recherches** par mots-clés (plusieurs pages, plusieurs tris) via les API
   publiques **Invidious** et **Piped** ;
2. **Flux RSS des chaînes validées** (`youtube.com/feeds/videos.xml`) — une requête par chaîne,
   directement chez YouTube, sans instance tierce ;
3. **Vidéos recommandées** récupérées au passage des requêtes de détail, mises en file ;
4. **Sources historiques** (`worker/sources.txt`, onglet Admin) via yt-dlp.

L'essentiel du volume vient des **listings** : une recherche renvoie déjà titre, chaîne, vues et
date, de quoi créer la carte sans requête supplémentaire. Les appels « une vidéo » servent aux
candidates dont on ignore les vues et sont **budgétés par cycle** (`DETAILS_PER_CYCLE`) : ces
instances sont bénévoles. Les cartes entrées par un listing partent dans une file d'enrichissement
qui complète catégorie et j'aime au fil des cycles — elles sont jouables immédiatement.

Une vidéo est retenue si elle dépasse `MIN_VIEWS`, dure plus de `MIN_SECONDS` (les Shorts sont
écartés) et obtient assez d'indices de francophonie : mots-outils français dans le titre ou la
description, sous-titres `fr`, ou chaîne déjà validée. Chaque vidéo retenue fait entrer sa chaîne
dans la liste suivie par RSS : le catalogue s'élargit tout seul.

**Instances** : elles ferment souvent. Le worker sonde chacune au démarrage sur un vrai endpoint
de données (beaucoup répondent encore sur `/stats` tout en ayant fermé leur API), complète sa liste
via l'annuaire officiel Invidious, met au repos celles qui échouent et refait le point tous les
60 cycles. Si les logs annoncent « aucune instance exploitable », renseigne `INVIDIOUS_INSTANCES`
et `PIPED_INSTANCES` depuis <https://api.invidious.io/> et <https://piped.video/>. À défaut, yt-dlp
prend le relais — bien plus lent, mais le jeu continue de se remplir.

L'onglet Admin affiche le rendement du dernier cycle : vidéos ajoutées, chaînes suivies, files
d'attente, rejets et santé des instances.

## Administration

Les comptes listés dans `ADMIN_USERS` (par défaut `EIRBLAST`) sont administrateurs à chaque démarrage ;
ils ne peuvent être ni rétrogradés ni suspendus depuis l'interface. Ils peuvent nommer d'autres
administrateurs, qui eux sont révocables.

L'onglet **Admin** donne accès à :

- **Vue d'ensemble** : joueurs, vidéos, pièces en circulation et bloquées, état du worker, annonces.
- **Joueurs** : créditer ou débiter pièces et packs, réinitialiser un mot de passe, nommer ou
  révoquer un administrateur, suspendre ou réactiver un compte.
- **Réglages** (appliqués sans redéploiement) : intervalle et réserve de packs, prix d'un pack,
  bonus d'ouverture, dotation de départ, commission, pas de surenchère, anti-snipe, ventes
  simultanées par joueur, ouverture des inscriptions, code d'invitation.
- **Sources** : ajouter, retirer ou remettre en tête de file une source du worker.
- **Enchères** : annuler une vente en cours (l'enchérisseur est remboursé, la carte rendue).

## Déploiement sur Coolify

1. Pousse ce dossier dans un dépôt Git (GitHub, GitLab, Gitea…).
2. Coolify : New Resource → Application → ton dépôt → Build Pack **Docker Compose**, fichier `/docker-compose.yml`.
3. Variables d'environnement (voir `.env.example`) : au minimum `REDIS_PASSWORD` (`openssl rand -hex 32`).
   `ADMIN_USERS` pour les administrateurs, `INVITE_CODE` si tu veux limiter la création de comptes.
4. Domaine : sur le service **web** uniquement, `https://ton-domaine.fr:8000`
   (le `:8000` indique à Coolify le port interne ; le site reste servi en 443 avec HTTPS automatique).
   Redis et le worker ne sont pas exposés.
5. Deploy. Suivre le remplissage dans les logs du service **worker**.

Les premières vidéos apparaissent après quelques minutes ; l'app affiche l'heure du dernier passage du worker.

Crée ton compte `EIRBLAST` dès le premier démarrage : le pseudo est réservé mais pas le compte,
et le premier à l'enregistrer récupère les droits d'administration.

## Exploitation

- **Mettre à jour yt-dlp** (YouTube change souvent) : redéployer le worker, le build récupère la dernière version.
  yt-dlp ne sert plus qu'en secours et pour les sources `ytsearch:`.
- **Trop peu de vidéos qui arrivent** : vérifier dans les logs du worker le nombre d'instances
  exploitables. Pour moissonner plus vite : augmenter `KEYWORDS_PER_CYCLE`, `SEARCH_PAGES` et
  `CHANNELS_PER_CYCLE`, ou raccourcir `CYCLE_PAUSE`. Rester raisonnable sur `API_WORKERS` et
  `DETAILS_PER_CYCLE` : les instances publiques sont tenues par des bénévoles.
- **Ajouter une source** : onglet Admin → Sources (ou, sans passer par l'app,
  `docker exec -it <redis> redis-cli -a "$REDIS_PASSWORD" ZADD sources 0 "https://www.youtube.com/@Chaine/videos"`).
- **Blocage YouTube** (logs « Sign in to confirm you're not a bot », pauses anti-blocage) : fréquent sur les IP
  de datacenter. Renseigner `YTDLP_PROXY` (proxy résidentiel) ; le worker ralentit déjà seul en cas d'échecs.
- **Rythme du worker** : voir `.env.example`, section worker. `CYCLE_PAUSE` règle l'ensemble.
- **Réglages du jeu** : dans l'onglet Admin, pas en variables d'environnement (sauf `MIN_VIEWS`).
- **Sauvegarde** : volume `redis-data` (fichier `appendonly`).
- **Mise à l'échelle** : le service web tient à une seule instance — la clôture des enchères y tourne
  en tâche de fond (protégée par un verrou Redis, donc plusieurs instances restent correctes).

## Test en local

```
cp .env.example .env   # remplir REDIS_PASSWORD, mettre COOKIE_SECURE=0
docker compose up --build
```
puis exposer le port : ajouter `ports: ["8000:8000"]` au service web le temps du test.
