# TubePacks

Jeu d'ouverture de packs de vidéos YouTube françaises : un pack offert toutes les 10 minutes,
collection par joueur, hôtel des ventes entre joueurs, profils publics et console d'administration.
Un worker alimente le jeu en continu (vidéos ≥ 10 000 vues) et rafraîchit vues et j'aime.

```
web/      FastAPI : pages, comptes (Argon2), sessions Redis, packs, enchères, admin
web/lua.py  scripts Lua : pièces et cartes déplacées de façon atomique côté Redis
worker/   yt-dlp + Deno : exploration continue des chaînes et recherches FR, découverte de chaînes
redis     données persistantes (AOF, volume redis-data)
```

## Le jeu

- **Packs** — 5 cartes. Un pack offert toutes les 10 minutes, jusqu'à 12 en réserve ; au-delà le
  compteur s'arrête. Chaque ouverture rapporte 20 pièces ; un pack supplémentaire coûte 250 pièces.
- **Raretés** — selon les vues de la vidéo : Commune, Rare (100 k), Épique (1 M), Légendaire (10 M),
  Mythique (100 M). Le curseur « vues minimum » restreint le tirage et l'affichage de la collection.
- **Pièces** — recyclage des doublons (5 à 1 500 pièces selon la rareté, un exemplaire est toujours
  conservé), bonus d'ouverture, ventes à l'hôtel des ventes.
- **Hôtel des ventes** — on met une carte en vente (elle quitte la collection le temps de l'enchère),
  durée 15 min à 24 h. Les pièces d'un enchérisseur sont bloquées et rendues dès qu'il est surenchéri.
  Surenchère minimale +5 %, commission de 5 % au vendeur, et toute mise dans la dernière minute
  prolonge l'enchère d'une minute (anti-snipe). Les enchères se clôturent toutes seules côté serveur.
- **Profil** — avatar, bio, statistiques, progression par rareté, plus belles cartes, classements.
  Les profils des autres joueurs sont consultables depuis le classement.

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
- **Ajouter une source** : onglet Admin → Sources (ou, sans passer par l'app,
  `docker exec -it <redis> redis-cli -a "$REDIS_PASSWORD" ZADD sources 0 "https://www.youtube.com/@Chaine/videos"`).
- **Blocage YouTube** (logs « Sign in to confirm you're not a bot », pauses anti-blocage) : fréquent sur les IP
  de datacenter. Renseigner `YTDLP_PROXY` (proxy résidentiel) ; le worker ralentit déjà seul en cas d'échecs.
- **Rythme du worker** : `PAUSE`, `CYCLE_PAUSE`, `PER_SOURCE`. Rester lent limite les risques de blocage.
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
