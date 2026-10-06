#!/bin/sh
# A fresh, unauthenticated profile is created and removed by the WPC provider.
# Chromium runs as the unprivileged app user inside the container.
exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"
