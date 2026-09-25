# Reference console image: the static build, plus a proxy that injects the
# operator credential server-side.
#
# Build the console FIRST, without a token:
#
#   cd apps/console
#   flutter build web --release \
#     --dart-define=API_BASE_URL=https://review.example.org
#
# then build this image from the repository root:
#
#   docker build -f deploy/console-proxy/Dockerfile -t tryveriqo-console .
#
# Run it with the credential in the ENVIRONMENT, never in the image:
#
#   docker run --rm -p 8080:8080 \
#     -e API_UPSTREAM=http://api:8080 \
#     -e ASSESSMENT_API_TOKEN="$ASSESSMENT_API_TOKEN" \
#     tryveriqo-console
#
# The token is substituted into the proxy's server-side config at container
# start. It is never sent to a browser and never appears in the console bundle.

FROM nginx:1.27-alpine

# The console's compiled web build. Built without --dart-define=API_TOKEN.
COPY apps/console/build/web/ /usr/share/nginx/html/

# envsubst template: the official image renders /etc/nginx/templates/*.template
# into /etc/nginx/conf.d/ at start, substituting only variables present in the
# environment.
COPY deploy/console-proxy/default.conf.template /etc/nginx/templates/default.conf.template

# Fail fast with a clear message rather than starting a proxy that would send
# "Bearer " and turn every request into an opaque 401.
RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'if [ -z "$ASSESSMENT_API_TOKEN" ]; then' \
  '  echo "FATAL: ASSESSMENT_API_TOKEN is not set; the console proxy would inject an empty credential." >&2' \
  '  exit 1' \
  'fi' \
  'if [ -z "$API_UPSTREAM" ]; then' \
  '  echo "FATAL: API_UPSTREAM is not set; the proxy has no API to forward to." >&2' \
  '  exit 1' \
  'fi' \
  'exec /docker-entrypoint.sh "$@"' \
  > /docker-entrypoint-failclosed.sh \
  && chmod +x /docker-entrypoint-failclosed.sh

ENTRYPOINT ["/docker-entrypoint-failclosed.sh"]
CMD ["nginx", "-g", "daemon off;"]
