#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_DIR="$BUILD_DIR/ClaudeTelemetry.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

# Without an explicit target, swiftc sets the minimum macOS to the SDK version,
# and the app refuses to launch on older systems (LaunchServices error -10825).
MIN_MACOS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$SCRIPT_DIR/Info.plist")"
for arch in arm64 x86_64; do
    swiftc -O -parse-as-library \
        -target "$arch-apple-macos$MIN_MACOS" \
        -framework SwiftUI -framework Charts -framework ServiceManagement \
        "$SCRIPT_DIR/ClaudeTelemetry.swift" "$SCRIPT_DIR/Settings.swift" \
        -o "$BUILD_DIR/ClaudeTelemetry-$arch"
done
lipo -create "$BUILD_DIR"/ClaudeTelemetry-arm64 "$BUILD_DIR"/ClaudeTelemetry-x86_64 -output "$MACOS_DIR/ClaudeTelemetry"
rm "$BUILD_DIR"/ClaudeTelemetry-arm64 "$BUILD_DIR"/ClaudeTelemetry-x86_64

cp "$SCRIPT_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"
# Release builds take the version from the git tag, not from the checked-in plist.
if [[ -n "${APP_VERSION:-}" ]]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$CONTENTS_DIR/Info.plist"
fi
if [[ -n "${APP_BUILD:-}" ]]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $APP_BUILD" "$CONTENTS_DIR/Info.plist"
fi

# Compiles the Icon Composer icon into Assets.car (light and dark) plus an .icns for older macOS.
# actool ships with Xcode 26, not with the Command Line Tools alone.
mkdir -p "$CONTENTS_DIR/Resources"
xcrun actool "$SCRIPT_DIR/AppIcon.icon" --compile "$CONTENTS_DIR/Resources" \
    --platform macosx --minimum-deployment-target "$MIN_MACOS" --app-icon AppIcon \
    --output-partial-info-plist "$BUILD_DIR/icon-partial.plist" \
    --errors --warnings --output-format human-readable-text
rm "$BUILD_DIR/icon-partial.plist"

# Ad-hoc by default. Set SIGN_IDENTITY to a Developer ID for a release build.
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
    codesign --force --sign - "$APP_DIR"
else
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP_DIR"
fi

echo "Built $APP_DIR"
