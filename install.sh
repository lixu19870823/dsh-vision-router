#!/usr/bin/env bash
set -euo pipefail

# dsh-vision-router one-line installer / uninstaller
# install : copy package into the profile, link it, append the mount row (idempotent).
#            The mount row is written LAST, so the profile's hot watcher picks it up
#            after the package is already resolvable - no dsh process restart needed.
# uninstall: remove the mount row, the link, and the package directory.

PKG_NAME="dsh-vision-router"
ROW_ID="vision-router"
REPO_URL="https://github.com/lixu19870823/dsh-vision-router.git"

usage() {
  cat <<'EOF'
Usage:
  ./install.sh                  # install into the default profile ($HOME/.dsh/profiles/web)
  ./install.sh <profile-dir>    # install into a specific profile
  ./install.sh --uninstall      # uninstall (DSH_PROFILE can select the profile too)

The DSH_PROFILE environment variable overrides the default profile directory.
EOF
}

# ── argument parsing ──
if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "-u" ]; then
  MODE=uninstall
  PROFILE="${2:-${DSH_PROFILE:-$HOME/.dsh/profiles/web}}"
elif [ -n "${1:-}" ]; then
  MODE=install
  PROFILE="${1}"
else
  MODE=install
  PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/web}"
fi

# ── profile validation ──
# Normalize to an absolute path, then require the profile's own package.json
# (a real dsh profile always has one carrying dsh.profile.bundles). This guard
# keeps every rm -rf / write below confined to a verified profile directory.
PROFILE="$(cd "${PROFILE}" 2>/dev/null && pwd)" || {
  echo "error: profile directory does not exist: ${PROFILE}" >&2
  usage
  exit 1
}
if [ ! -f "${PROFILE}/package.json" ] || ! grep -q '"profile"' "${PROFILE}/package.json"; then
  echo "error: ${PROFILE} does not look like a dsh profile (no package.json with a dsh.profile block); refusing to touch it" >&2
  usage
  exit 1
fi

PATCH="${PROFILE}/cordis.patch.yml"
TARGET="${PROFILE}/packages/${PKG_NAME}"
LINK="${PROFILE}/node_modules/${PKG_NAME}"
OLD_LINK="${PROFILE}/node_modules/@deepseek-ai/${PKG_NAME}"

require_python3() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "error: python3 is required to edit cordis.patch.yml safely" >&2
    exit 1
  fi
}

# ── uninstall ──
if [ "${MODE}" = "uninstall" ]; then
  require_python3
  if [ -f "${PATCH}" ]; then
    python3 - "${PATCH}" "${ROW_ID}" <<'PYEOF'
import io, sys
path, row_id = sys.argv[1], sys.argv[2]
lines = io.open(path, encoding="utf-8").read().split("\n")
out, i, removed = [], 0, False
while i < len(lines):
    line = lines[i]
    if line.strip() == "- insert:" and i + 1 < len(lines) and lines[i + 1].strip() == "- id: %s" % row_id:
        i += 2
        # consume only the continuation lines of this insert block (indented or blank)
        while i < len(lines) and (lines[i].strip() == "" or lines[i].startswith((" ", "\t"))):
            i += 1
        removed = True
        continue
    out.append(line)
    i += 1
text = "\n".join(out).strip()
if not text or text.endswith("[]"):
    text = ("# Your patch layer for this dsh profile, applied after every bundle layer:\n"
            "# a top-level YAML array of loader patch entries (id-targeted config\n"
            "# overrides, disables, and insert lists; `!!js` expressions allowed).\n"
            "[]\n")
elif not text.endswith("\n"):
    text += "\n"
io.open(path, "w", encoding="utf-8").write(text)
print("removed" if removed else "not-found")
PYEOF
  fi
  rm -f "${LINK}" "${OLD_LINK}"
  rm -rf "${TARGET}"
  echo "OK uninstalled ${PKG_NAME} (the mount row removal hot-reloads immediately)"
  exit 0
fi

# ── install ──
require_python3
if ! command -v git >/dev/null 2>&1; then
  echo "error: git is required to fetch the source (or clone the repo manually and run this script from inside it)" >&2
  exit 1
fi

# 1) source: the repo itself when the script sits beside its package.json, else a shallow clone
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [ -f "${SCRIPT_DIR}/package.json" ] && grep -q '"name": "dsh-vision-router"' "${SCRIPT_DIR}/package.json" 2>/dev/null; then
  SRC="${SCRIPT_DIR}"
else
  SRC="${TMPDIR:-/tmp}/dsh-vision-router-src"
  rm -rf "${SRC}"
  git clone --depth 1 "${REPO_URL}" "${SRC}" >/dev/null
fi

# 2) copy into the profile (overwrites the local copy with the published version)
mkdir -p "${PROFILE}/packages"
rm -rf "${TARGET}"
mkdir -p "${TARGET}"
cp -R "${SRC}/lib" "${TARGET}/lib"
cp "${SRC}/package.json" "${TARGET}/package.json"

# 3) resolution links (new unscoped name; drop the old scoped name if present)
mkdir -p "${PROFILE}/node_modules"
ln -sfn "../packages/${PKG_NAME}" "${LINK}"
rm -f "${OLD_LINK}"

# 4) mount row (idempotent; written LAST so the hot reload resolves the package)
python3 - "${PATCH}" "${ROW_ID}" "${PKG_NAME}" <<'PYEOF'
import io, sys
path, row_id, pkg = sys.argv[1], sys.argv[2], sys.argv[3]
if io.open(path, encoding="utf-8").read().find(pkg) != -1:
    print("patch-already-has-row")
    sys.exit(0)
block = "- insert:\n    - id: %s\n      name: '%s'\n" % (row_id, pkg)
lines = io.open(path, encoding="utf-8").read().split("\n")
stripped = [line.strip() for line in lines]
try:
    idx = next(i for i, s in enumerate(stripped) if s == "[]")
    lines[idx] = block.rstrip("\n")
    text = "\n".join(lines)
except StopIteration:
    text = io.open(path, encoding="utf-8").read()
    if text and not text.endswith("\n"):
        text += "\n"
    text += block
io.open(path, "w", encoding="utf-8").write(text)
print("patch-updated")
PYEOF

echo ""
echo "OK dsh-vision-router installed (profile: ${PROFILE})"
echo "   The mount row is hot-reloaded; no dsh process restart needed."
echo ""
echo "   Next steps:"
echo "   1. Refresh the browser page."
echo "   2. Settings > Models: add a custom provider with a vision-capable model."
echo "   3. Settings > Plugins > Configurable > vision-router: pick the model"
echo "      (tick 'image input' if it is not declared) and save."
echo ""
echo "   Uninstall: $0 --uninstall"
