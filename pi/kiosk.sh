#!/bin/sh
# Opens the dashboard full screen once the OBD Dash server is up.
URL="http://localhost:8080"
for i in $(seq 1 60); do
  curl -fs "$URL" >/dev/null 2>&1 && break
  sleep 1
done
BROWSER=$(command -v chromium || command -v chromium-browser)
exec "$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run \
  --password-store=basic --disable-features=Translate --check-for-update-interval=31536000 \
  --app="$URL"
