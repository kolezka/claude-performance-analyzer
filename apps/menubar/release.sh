#!/usr/bin/env bash
# Builds a signed, notarized DMG. With PUBLISH=1 it also pushes the version tag
# and creates the GitHub release. CI is the normal way to publish.
# Needs a "Developer ID Application" cert and a notarytool keychain profile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# git and gh must act on this repo, whatever directory the script is called from.
cd "$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

BUILD_DIR="$SCRIPT_DIR/build"
APP_DIR="$BUILD_DIR/ClaudeTelemetry.app"
NOTARY_PROFILE="${NOTARY_PROFILE:-cpa-notary}"
SIGN_IDENTITY="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"

if [[ -z "$SIGN_IDENTITY" ]]; then
    echo "No Developer ID Application identity found in the keychain." >&2
    exit 1
fi

# The build reads the working tree, so it must match the commit the release points at.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "Working tree has uncommitted changes. Commit or stash them first." >&2
    exit 1
fi

APP_VERSION="${APP_VERSION:-$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SCRIPT_DIR/Info.plist")}"
# One build number per release, so it always increases with the version.
APP_BUILD="${APP_BUILD:-$APP_VERSION}"
TAG="v$APP_VERSION"
DMG="$BUILD_DIR/ClaudeTelemetry-$APP_VERSION.dmg"
HEAD_SHA="$(git rev-parse HEAD)"

# Commit a remote tag points at. ls-remote lists the tag object before the
# peeled commit, so pick the ^{} line by name and fall back for lightweight tags.
remote_tag_commit() {
    local refs
    refs="$(git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}")"
    awk -v peeled="refs/tags/$TAG^{}" '$2 == peeled {print $1; found=1} END {if (!found) exit 1}' <<< "$refs" ||
        awk -v plain="refs/tags/$TAG" '$2 == plain {print $1}' <<< "$refs"
}

if [[ "${PUBLISH:-0}" == "1" ]]; then
    if gh release view "$TAG" >/dev/null 2>&1; then
        echo "Release $TAG already exists. If it is a leftover draft, delete it and run again." >&2
        exit 1
    fi
    if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && [[ "$(git rev-parse "$TAG^{commit}")" != "$HEAD_SHA" ]]; then
        echo "Local tag $TAG points at a different commit." >&2
        exit 1
    fi
    REMOTE_TAG_SHA="$(remote_tag_commit)"
    if [[ -n "$REMOTE_TAG_SHA" && "$REMOTE_TAG_SHA" != "$HEAD_SHA" ]]; then
        echo "Tag $TAG already exists on origin at a different commit." >&2
        exit 1
    fi
    if [[ -z "$(git branch -r --contains "$HEAD_SHA")" ]]; then
        echo "HEAD is not pushed to origin." >&2
        exit 1
    fi
fi

APP_VERSION="$APP_VERSION" APP_BUILD="$APP_BUILD" SIGN_IDENTITY="$SIGN_IDENTITY" "$SCRIPT_DIR/build.sh"
codesign --verify --strict --deep "$APP_DIR"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
cp -R "$APP_DIR" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
rm -f "$DMG"
hdiutil create -volname ClaudeTelemetry -srcfolder "$STAGING" -ov -format UDZO "$DMG"
codesign --sign "$SIGN_IDENTITY" --timestamp "$DMG"

# Notarizing the DMG also notarizes the app inside it.
NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
if [[ -n "${NOTARY_KEYCHAIN:-}" ]]; then
    NOTARY_ARGS+=(--keychain "$NOTARY_KEYCHAIN")
fi
xcrun notarytool submit "$DMG" "${NOTARY_ARGS[@]}" --wait
xcrun stapler staple "$DMG"
spctl --assess --type open --context context:primary-signature -vv "$DMG"

if [[ "${PUBLISH:-0}" != "1" ]]; then
    echo "Built $DMG (not published, set PUBLISH=1 to publish)"
    exit 0
fi

# Without --force, git refuses to move a tag someone created in the meantime.
if [[ -z "$(remote_tag_commit)" ]]; then
    git push origin "$HEAD_SHA:refs/tags/$TAG"
fi
# --verify-tag only checks that the tag exists, so confirm it is still ours.
if [[ "$(remote_tag_commit)" != "$HEAD_SHA" ]]; then
    echo "Tag $TAG on origin no longer points at $HEAD_SHA. Not publishing." >&2
    exit 1
fi
gh release create "$TAG" "$DMG" --verify-tag --title "ClaudeTelemetry $APP_VERSION" \
    --notes "The menu bar app reads data from the local collector. Clone this repository and run \`bun run start\` before opening the app." \
    --generate-notes
