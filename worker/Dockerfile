FROM python:3.13-slim
# Deno : runtime JavaScript requis par yt-dlp pour YouTube (épingle une version bin-2.x si besoin)
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
WORKDIR /app
COPY requirements.txt .
# Sans version figée : chaque rebuild récupère le yt-dlp le plus récent
RUN pip install --no-cache-dir -U -r requirements.txt
COPY worker.py sources.txt ./
RUN useradd -m app
USER app
CMD ["python", "-u", "worker.py"]
