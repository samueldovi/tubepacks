# TubePacks

Jeu d'ouverture de packs de vidéos YouTube françaises : portail de connexion, collection par joueur,
worker qui ajoute en continu de nouvelles vidéos (≥ 10 000 vues) et rafraîchit vues et j'aime.

```
web/      FastAPI : pages, comptes (Argon2), sessions Redis, tirage des packs côté serveur
worker/   yt-dlp + Deno : exploration continue des chaînes et recherches FR, découverte de chaînes
redis     données persistantes (AOF, volume redis-data)
```

## Déploiement sur Coolify

1. Pousse ce dossier dans un dépôt Git (GitHub, GitLab, Gitea…).
2. Coolify : New Resource → Application → ton dépôt → Build Pack **Docker Compose**, fichier `/docker-compose.yml`.
3. Variables d'environnement (voir `.env.example`) : au minimum `REDIS_PASSWORD` (`openssl rand -hex 32`).
   `INVITE_CODE` si tu veux limiter la création de comptes.
4. Domaine : sur le service **web** uniquement, `https://ton-domaine.fr:8000`
   (le `:8000` indique à Coolify le port interne ; le site reste servi en 443 avec HTTPS automatique).
   Redis et le worker ne sont pas exposés.
5. Deploy. Suivre le remplissage dans les logs du service **worker**.

Les premières vidéos apparaissent après quelques minutes ; l'app affiche l'heure du dernier passage du worker.

## Exploitation

- **Mettre à jour yt-dlp** (YouTube change souvent) : redéployer le worker, le build récupère la dernière version.
- **Ajouter une source** sans redéployer :
  `docker exec -it <redis> redis-cli -a "$REDIS_PASSWORD" ZADD sources 0 "https://www.youtube.com/@Chaine/videos"`
- **Blocage YouTube** (logs « Sign in to confirm you're not a bot », pauses anti-blocage) : fréquent sur les IP
  de datacenter. Renseigner `YTDLP_PROXY` (proxy résidentiel) ; le worker ralentit déjà seul en cas d'échecs.
- **Rythme** : `PAUSE`, `CYCLE_PAUSE`, `PER_SOURCE`. Rester lent limite les risques de blocage.
- **Sauvegarde** : volume `redis-data` (fichier `appendonly`).

## Test en local

```
cp .env.example .env   # remplir REDIS_PASSWORD, mettre COOKIE_SECURE=0
docker compose up --build
```
puis exposer le port : ajouter `ports: ["8000:8000"]` au service web le temps du test.
