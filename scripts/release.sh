#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GRADLE_PROPS="$ROOT_DIR/kotlin/gradle.properties"

CURRENT_VERSION=$(grep '^VERSION_NAME=' "$GRADLE_PROPS" | cut -d= -f2)

usage() {
    echo "Current version: $CURRENT_VERSION"
    echo ""
    echo "Usage:"
    echo "  $0 <version>              Release a stable version"
    echo "  $0 --snapshot <version>   Release a SNAPSHOT version"
    echo ""
    echo "Examples:"
    echo "  $0 1.0.7                  -> tag v1.0.7, VERSION_NAME=1.0.7"
    echo "  $0 --snapshot 1.0.8       -> tag v1.0.8-SNAPSHOT, VERSION_NAME=1.0.8-SNAPSHOT"
    echo ""
    echo "Release flow:"
    echo "  1. Update VERSION_NAME in kotlin/gradle.properties"
    echo "  2. Commit the version bump"
    echo "  3. Create and push a git tag"
    echo "  4. Trigger CI build & JitPack publish"
    exit 0
}

[ $# -eq 0 ] && usage

SNAPSHOT=false
if [ "$1" = "--snapshot" ] || [ "$1" = "-s" ]; then
    SNAPSHOT=true
    shift
    [ $# -eq 0 ] && { echo "Error: version argument required after --snapshot"; exit 1; }
fi

BASE_VERSION="$1"

if [[ ! "$BASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: Invalid version format '$BASE_VERSION'. Expected: X.Y.Z"
    exit 1
fi

if [ "$SNAPSHOT" = true ]; then
    NEW_VERSION="${BASE_VERSION}-SNAPSHOT"
    TAG="v${BASE_VERSION}-SNAPSHOT"
    COMMIT_MSG="snapshot: bump version to $NEW_VERSION"
else
    NEW_VERSION="$BASE_VERSION"
    TAG="v${NEW_VERSION}"
    COMMIT_MSG="release: bump version to $NEW_VERSION"
fi

if git -C "$ROOT_DIR" rev-parse "$TAG" >/dev/null 2>&1; then
    echo "Error: Tag '$TAG' already exists."
    exit 1
fi

echo "Type:    $([ "$SNAPSHOT" = true ] && echo "SNAPSHOT" || echo "RELEASE")"
echo "Version: $CURRENT_VERSION -> $NEW_VERSION"
echo "Tag:     $TAG"
echo ""

if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/^VERSION_NAME=.*/VERSION_NAME=${NEW_VERSION}/" "$GRADLE_PROPS"
else
    sed -i "s/^VERSION_NAME=.*/VERSION_NAME=${NEW_VERSION}/" "$GRADLE_PROPS"
fi

echo "Updated VERSION_NAME to $NEW_VERSION"

cd "$ROOT_DIR"
git add kotlin/gradle.properties
git commit -m "$COMMIT_MSG"
git tag -a "$TAG" -m "$([ "$SNAPSHOT" = true ] && echo "Snapshot" || echo "Release") $NEW_VERSION"

echo ""
echo "Commit and tag '$TAG' created."
echo ""
read -rp "Push commit and tag to origin? [y/N] " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
    git push origin HEAD
    git push origin "$TAG"
    echo ""
    echo "Pushed to origin. CI will build and verify."
    echo "JitPack dependency:"
    echo "  org.difft.android.libraries:denoise-filter:$TAG"
else
    echo ""
    echo "Skipped push. Run manually when ready:"
    echo "  git push origin HEAD && git push origin $TAG"
fi
