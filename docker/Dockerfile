# Build + test environment for the Laxative extension.
# Everything (node, VS Code, Electron) lives in here; the host stays untouched.
FROM node:20-bookworm

# Runtime libraries VS Code's Electron build needs, plus a virtual display.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
      libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 \
      libnspr4 libnss3 libpango-1.0-0 libsecret-1-0 libx11-6 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
      libxss1 xvfb xauth git \
      x11vnc novnc websockify openbox \
    && rm -rf /var/lib/apt/lists/*

# Dependencies are installed into the image so the host never gets a
# node_modules directory, and re-runs skip the install entirely.
WORKDIR /deps
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

RUN mkdir -p /work /cache && chmod 777 /work /cache
ENV HOME=/tmp \
    NPM_CONFIG_CACHE=/tmp/.npm \
    VSCODE_TEST_CACHE=/cache \
    DONT_PROMPT_WSL_INSTALL=1

COPY docker/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["all"]
