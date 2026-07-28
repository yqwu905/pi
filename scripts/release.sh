#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version>" >&2
  exit 2
fi

version="${1#v}"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

[[ "$(git branch --show-current)" == "main" ]] || {
  echo "Release must run from main." >&2
  exit 1
}

git fetch origin --tags
git diff --check
npm version "$version" --no-git-tag-version --allow-same-version
npm install
npm run check
npm audit --omit=dev --registry=https://registry.npmjs.org

git add package.json package-lock.json README.md THIRD_PARTY_NOTICES.md skills scripts
git diff --cached --check
git commit -m "Release Pi bundle v$version"
git tag -a "v$version" -m "v$version"
git push origin main
git push origin "v$version"
gh release create "v$version" --repo yqwu905/pi --generate-notes --title "v$version"

echo "Released v$version"
