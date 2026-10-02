#!/usr/bin/env bash
# Builds a signed, notarized DMG and publishes it as a GitHub release.
# Needs a "Developer ID Application" cert and a notarytool keychain profile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_DIR="$BUILD_DIR/ClaudeTelemetry.app"
NOTARY_PROFILE="${NOTARY_PROFILE:-cpa-notary}"
SIGN_IDENTITY="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"

if [[ -z "$SIGN_IDENTITY" ]]; then
    echo "No Developer ID Application identity found in the keychain." >&2
    exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SCRIPT_DIR/Info.plist")"
TAG="v$VERSION"
DMG="$BUILD_DIR/ClaudeTelemetry-$VERSION.dmg"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || gh release view "$TAG" >/dev/null 2>&1; then
    echo "$TAG already exists. Bump CFBundleShortVersionString in Info.plist." >&2
    exit 1
fi

SIGN_IDENTITY="$SIGN_IDENTITY" "$SCRIPT_DIR/build.sh"
codesign --verify --strict --deep "$APP_DIR"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
cp -R "$APP_DIR" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
rm -f "$DMG"
hdiutil create -volname ClaudeTelemetry -srcfolder "$STAGING" -ov -format UDZO "$DMG"
codesign --sign "$SIGN_IDENTITY" --timestamp "$DMG"

# Notarizing the DMG also notarizes the app inside it.
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"
spctl --assess --type open --context context:primary-signature -vv "$DMG"

if [[ "${PUBLISH:-1}" == "1" ]]; then
    gh release create "$TAG" "$DMG" --title "ClaudeTelemetry $VERSION" --generate-notes
else
    echo "Built $DMG (not published, PUBLISH=0)"
fi
