FROM node:22-bookworm-slim AS builder

WORKDIR /app
ARG NPM_VERSION=11.17.0
RUN npm install -g "npm@${NPM_VERSION}" \
  && node -e "const v=require('/usr/local/lib/node_modules/npm/node_modules/tar/package.json').version; const [a,b,c]=v.split('.').map(Number); if (a < 7 || (a === 7 && (b < 5 || (b === 5 && c < 16)))) throw new Error('npm embeds vulnerable tar '+v); console.log('npm tar', v);"
COPY package*.json tsconfig.json ./
RUN npm install && npm install --no-save playwright@1.60.0 top-user-agents@2.1.111
COPY src/ ./src/
RUN npm run build

# ── Image finale (sans devDependencies ni sources TS) ──────────────────────
FROM node:22-bookworm-slim

WORKDIR /app
ARG NPM_VERSION=11.17.0
RUN npm install -g "npm@${NPM_VERSION}" \
  && node -e "const v=require('/usr/local/lib/node_modules/npm/node_modules/tar/package.json').version; const [a,b,c]=v.split('.').map(Number); if (a < 7 || (a === 7 && (b < 5 || (b === 5 && c < 16)))) throw new Error('npm embeds vulnerable tar '+v); console.log('npm tar', v);"
ARG APP_IMAGE_SOURCE=local
ARG APP_IMAGE_VERSION=dev
ARG APP_IMAGE_REVISION=unknown
ARG APP_IMAGE_REF=local
ENV APP_IMAGE_SOURCE=$APP_IMAGE_SOURCE \
    APP_IMAGE_VERSION=$APP_IMAGE_VERSION \
    APP_IMAGE_REVISION=$APP_IMAGE_REVISION \
    APP_IMAGE_REF=$APP_IMAGE_REF
COPY package*.json ./
RUN npm install --omit=dev && npm install --omit=dev --no-save playwright@1.60.0 top-user-agents@2.1.111
RUN npx playwright install --with-deps chromium
RUN apt-get update \
  && apt-get install --only-upgrade -y --no-install-recommends libgnutls30 \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── curl-impersonate (fast-path : lecture HTTP avec empreinte navigateur) ────
# Telecharge le binaire pour l'arch cible. Etape NON bloquante : si indisponible,
# le fast-path est simplement desactive et l'app utilise le navigateur.
ARG TARGETARCH
ENV CURL_IMPERSONATE_BIN=curl_impersonate \
    PATH="/opt/curl-impersonate:${PATH}" \
    LD_LIBRARY_PATH="/opt/curl-impersonate"
RUN set -u; \
  case "${TARGETARCH:-amd64}" in \
    amd64) CI_ARCH=x86_64 ;; \
    arm64) CI_ARCH=aarch64 ;; \
    *) CI_ARCH='' ;; \
  esac; \
  if [ -n "$CI_ARCH" ]; then \
    ver=v1.1.1; \
    url="https://github.com/lexiforest/curl-impersonate/releases/download/${ver}/curl-impersonate-${ver}.${CI_ARCH}-linux-gnu.tar.gz"; \
    mkdir -p /opt/curl-impersonate; \
    ( curl -fsSL "$url" -o /tmp/ci.tar.gz \
      && tar -xzf /tmp/ci.tar.gz -C /opt/curl-impersonate \
      && rm -f /tmp/ci.tar.gz \
      && ln -sf "$(ls /opt/curl-impersonate/curl_chrome* | sort | tail -1)" /opt/curl-impersonate/curl_impersonate \
      && /opt/curl-impersonate/curl_impersonate --version >/dev/null \
      && echo "curl-impersonate installe ($CI_ARCH)" ) \
    || echo "::warning:: curl-impersonate non installe — fast-path desactive, navigateur utilise."; \
  fi

# ── CloakBrowser (moteur navigateur furtif, opt-in dans la WebUI) ───────────
# Installe + pre-telecharge le binaire. Etape NON bloquante : si l'install ou le
# telechargement echoue, l'image se construit quand meme et l'app retombe
# automatiquement sur Chromium au runtime.
ENV CLOAKBROWSER_CACHE_DIR=/app/.cloakbrowser \
    CLOAKBROWSER_AUTO_UPDATE=false
RUN npm install --omit=dev --no-save cloakbrowser playwright-core \
  && node -e "import('cloakbrowser').then(m => m.ensureBinary && m.ensureBinary()).catch(e => { console.error('CloakBrowser binary skip:', e.message); })" \
  || echo "::warning:: CloakBrowser indisponible a la construction — l'app utilisera Chromium par defaut."

COPY --from=builder /app/dist ./dist
COPY public/ ./public/
COPY config/trackers/ ./default-trackers/

EXPOSE 3000
CMD ["node", "--experimental-sqlite", "dist/index.js"]
