# Synthetic lab target for "chall 2 - Safe Mode". Intentionally vulnerable.
# Build-only, offline, no external downloads. Runs as a non-root user.
FROM python:3.12-slim

# A non-root service account. The server runs as this user, so remote code
# execution runs as this user too -- non-root limits the blast radius but does
# not stop the exploit.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin ops \
    && mkdir -p /opt/opsbot/logs

COPY server.py /opt/opsbot/server.py
COPY config/security.yaml /opt/opsbot/config/security.yaml
COPY config/agent.jsonl /opt/opsbot/logs/agent.jsonl

# The "capture the flag" marker. It is a normal file the service account can
# read, which is the point: the tool server can read anything its user can.
RUN printf 'WSEC{bash_on_the_allowlist_is_still_a_shell}\n' > /flag.txt \
    && chmod 0644 /flag.txt \
    && chown -R ops:ops /opt/opsbot

USER ops
WORKDIR /opt/opsbot
EXPOSE 8808
# PORT and the deploy credential come from docker-compose.yml.
CMD ["python3", "/opt/opsbot/server.py"]
