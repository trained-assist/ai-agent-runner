#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Usage: sudo scripts/install-playwright-runtime.sh" >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot determine the Linux distribution" >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" || ( "${VERSION_ID:-}" != "22.04" && "${VERSION_ID:-}" != "24.04" ) ]]; then
  echo "Playwright runtime dependencies are supported on Ubuntu 22.04 and 24.04" >&2
  exit 1
fi

command -v apt-get >/dev/null || { echo "apt-get is required" >&2; exit 1; }
command -v apt-cache >/dev/null || { echo "apt-cache is required" >&2; exit 1; }

# Ubuntu 24.04 renamed several packages with the t64 transition. Resolve each
# known pair from the enabled Ubuntu repositories, then install only browser
# shared-library dependencies; do not upgrade the OS or install a browser.
apt-get update
package_pairs=(
  "libasound2|libasound2t64"
  "libatk1.0-0|libatk1.0-0t64"
  "libatk-bridge2.0-0|libatk-bridge2.0-0t64"
  "libatspi2.0-0|libatspi2.0-0t64"
  "libcairo2"
  "libcups2|libcups2t64"
  "libdbus-1-3"
  "libdrm2"
  "libexpat1"
  "libfontconfig1"
  "libfreetype6"
  "libgbm1"
  "libglib2.0-0|libglib2.0-0t64"
  "libgtk-3-0|libgtk-3-0t64"
  "libnspr4"
  "libnss3"
  "libpango-1.0-0"
  "libx11-6"
  "libx11-xcb1"
  "libxcb1"
  "libxcb-shm0"
  "libxcb-dri3-0"
  "libxcomposite1"
  "libxdamage1"
  "libxext6"
  "libxfixes3"
  "libxrandr2"
  "libxrender1"
  "libxss1"
  "libxtst6"
)
packages=()
for pair in "${package_pairs[@]}"; do
  resolved=""
  IFS='|' read -r -a candidates <<<"${pair}"
  for candidate in "${candidates[@]}"; do
    candidate_version="$(apt-cache policy "${candidate}" | awk '/^[[:space:]]*Candidate:/ { print $2; exit }')"
    if [[ -n "${candidate_version}" && "${candidate_version}" != "(none)" ]]; then
      resolved="${candidate}"
      break
    fi
  done
  if [[ -z "${resolved}" ]]; then
    echo "No available package candidate for ${pair}" >&2
    exit 1
  fi
  packages+=("${resolved}")
done

DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
ldconfig
ldconfig -p | grep -F 'libatk-1.0.so.0' >/dev/null || {
  echo "Chromium runtime check failed: libatk-1.0.so.0 is unavailable" >&2
  exit 1
}
echo "Installed Playwright Chromium runtime libraries; no browser binary or service restart was performed."
