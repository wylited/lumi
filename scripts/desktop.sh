#!/usr/bin/env bash
#
# Build the desktop app, sign it with a stable identity, and run it from a
# stable path — so macOS permissions survive a rebuild.
#
#   ./scripts/desktop.sh            build, sign, install, launch
#   ./scripts/desktop.sh --no-build reuse the last build
#
# Why this exists: Tauri ad-hoc signs by default, and macOS TCC keys a grant to
# the code signature. Every rebuild is a new CDHash, so every grant was thrown
# away and the app was a stranger in the privacy panes again. One self-signed
# "Lumi Dev" identity plus one install path (~/Applications/Lumi.app) makes the
# designated requirement stable, and the grants stick.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IDENTITY="Lumi Dev"
BUNDLE_ID="app.lumi.desktop"
BUILT="$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Lumi.app"
INSTALLED="$HOME/Applications/Lumi.app"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

say() { printf '\n==> %s\n' "$*"; }

# 1. The identity, created once and reused forever.
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  say "Creating the '$IDENTITY' code-signing identity (one time)"
  TMP="$(mktemp -d)"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
    -subj "/CN=$IDENTITY" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" \
    -addext "basicConstraints=critical,CA:false" >/dev/null 2>&1
  # macOS's Security framework cannot read OpenSSL 3's default (AES/PBKDF2)
  # PKCS#12. Homebrew openssl takes -legacy; LibreSSL's defaults are already
  # the old algorithms, which is why this branches on the version.
  LEGACY=""
  if openssl version 2>/dev/null | grep -q "^OpenSSL 3"; then LEGACY="-legacy"; fi
  openssl pkcs12 -export $LEGACY -out "$TMP/lumi.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -passout pass:lumi >/dev/null 2>&1
  security import "$TMP/lumi.p12" -k "$KEYCHAIN" -P lumi -T /usr/bin/codesign -A >/dev/null
  rm -rf "$TMP"
fi

# 2. Build, unless told to reuse.
if [ "${1:-}" != "--no-build" ]; then
  say "Building"
  pnpm --filter @heli/desktop tauri build
fi

# 3. Sign with the stable identity, under the app's real bundle id.
say "Signing with '$IDENTITY'"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$BUILT/Contents/Info.plist"
codesign --force --deep --sign "$IDENTITY" --identifier "$BUNDLE_ID" "$BUILT"
codesign -dv --verbose=2 "$BUILT" 2>&1 | grep -E "Identifier|Authority" | head -3

# 4. Install where TCC expects it, and run it from there.
say "Installing to $INSTALLED"
mkdir -p "$HOME/Applications"
pkill -f "Lumi.app/Contents/MacOS/lumi" 2>/dev/null || true
sleep 1
rm -rf "$INSTALLED"
cp -R "$BUILT" "$INSTALLED"
open "$INSTALLED"

say "Running"
sleep 2
pgrep -fl "$INSTALLED/Contents/MacOS/lumi" | head -1
