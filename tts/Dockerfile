# Piper TTS sidecar: local neural text-to-speech for Ondoku's read aloud (CPU).
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN pip install piper-tts==1.8.0
WORKDIR /app
COPY server.py entrypoint.sh ./
RUN chmod +x entrypoint.sh && useradd --uid 1000 --no-create-home --shell /usr/sbin/nologin piper && mkdir -p /voices
ENV VOICES_DIR=/voices PORT=5000 ORT_DISABLE_TELEMETRY=1
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/health', timeout=4)" || exit 1
ENTRYPOINT ["./entrypoint.sh"]
CMD ["python", "server.py"]
