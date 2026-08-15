#!/usr/bin/env bash
set -euo pipefail

PI_WEB_URL="http://127.0.0.1:8504"
MODE="enable"

usage() {
  cat <<'EOF'
Usage: setup-pi-web-tailscale.sh [--check|--off]

Expose the loopback-only PI WEB service to your private Tailnet with
Tailscale Serve. This script never enables Tailscale Funnel/public access.

  (no args)  Enable background HTTPS Serve for PI WEB
  --check    Show local PI WEB, Tailscale, and Serve status
  --off      Disable the current Tailscale Serve configuration
EOF
}

case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  --off) MODE="off" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

if ! command -v tailscale >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Tailscale CLI is not available.

1. Install Tailscale on this Mac: https://tailscale.com/download/mac
2. Open the app and sign in.
3. Install Tailscale on your phone and sign in to the same Tailnet.
4. Re-run this script.
EOF
  exit 1
fi

if ! tailscale status >/dev/null 2>&1; then
  echo "Tailscale is installed but not connected. Open the app and sign in first." >&2
  exit 1
fi

if [[ "$MODE" == "off" ]]; then
  tailscale serve off
  echo "✓ Tailscale Serve is disabled."
  exit 0
fi

if ! curl -fsS "$PI_WEB_URL/api/pi-web/version" >/dev/null; then
  echo "PI WEB is not healthy at $PI_WEB_URL. Run scripts/setup-pi-web.sh --check first." >&2
  exit 1
fi

if [[ "$MODE" == "enable" ]]; then
  # Port proxying is supported by the sandboxed macOS Tailscale app and stays
  # private to the Tailnet. Do not replace this with `tailscale funnel`.
  tailscale serve --bg 8504
fi

echo "--- Tailscale device ---"
tailscale status
echo "--- Tailscale Serve ---"
tailscale serve status

echo
if [[ "$MODE" == "enable" ]]; then
  echo "✓ PI WEB is available only inside your Tailnet at the HTTPS URL shown above."
else
  echo "✓ Tailscale and local PI WEB are healthy."
fi
