#!/usr/bin/env sh
set -eu

DEFAULT_REPO="https://github.com/nil4u/issue-flow.git"
DEFAULT_REF="main"

usage() {
  cat <<'EOF'
Usage: install.sh [github|gitlab|auto] [--force] [--dry-run] [--plan-json] [--decision-file <path>]

Installs issue-flow into the current project.
After you commit and push the installed workflow files, CI automatically synchronizes issue-flow provider labels.

Options:
  --force                  Apply without asking; overwrite conflicting files.
  --dry-run                Print files that would be written without writing them.
  --plan-json              Print the install conflict plan as JSON and exit 0 (writes nothing).
  --decision-file <path>   Apply per-conflict decisions from a JSON file produced against --plan-json.
                           Exits 4 with install_plan_changed JSON when the plan fingerprint no longer matches.

Examples:
  curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/plugin/install.sh -o /tmp/issue-flow-install.sh && bash /tmp/issue-flow-install.sh github
  curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/plugin/install.sh -o /tmp/issue-flow-install.sh && bash /tmp/issue-flow-install.sh gitlab --dry-run

Download before running when reinstall conflicts may need a prompt.
The curl | bash form cannot prompt because stdin is occupied by the pipe.

Environment:
  ISSUE_FLOW_REPO  Git repository to clone. Defaults to https://github.com/nil4u/issue-flow.git
  ISSUE_FLOW_REF   Branch or tag to clone. Defaults to main
EOF
}

die() {
  printf 'issue-flow install: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

script_dir() {
  case "$0" in
    */*)
      CDPATH= cd -- "$(dirname -- "$0")" && pwd
      ;;
    *)
      if [ -f "$0" ]; then
        pwd
      else
        printf ''
      fi
      ;;
  esac
}

detect_target() {
  remote="$(git config --get remote.origin.url 2>/dev/null || true)"
  if [ -f ".gitlab-ci.yml" ]; then
    printf 'gitlab'
    return
  fi
  if printf '%s' "$remote" | grep -qi 'github'; then
    printf 'github'
    return
  fi
  if [ -n "$remote" ]; then
    printf 'gitlab'
    return
  fi
  printf 'github'
}

clone_source() {
  repo="${ISSUE_FLOW_REPO:-$DEFAULT_REPO}"
  ref="${ISSUE_FLOW_REF:-$DEFAULT_REF}"
  temp_root="$(mktemp -d "${TMPDIR:-/tmp}/issue-flow-install.XXXXXX")"
  trap 'rm -rf "$temp_root"' EXIT INT TERM

  if [ -n "$ref" ]; then
    git clone --quiet --depth 1 --branch "$ref" "$repo" "$temp_root/issue-flow"
  else
    git clone --quiet --depth 1 "$repo" "$temp_root/issue-flow"
  fi
  # Monorepo layout keeps the plugin under plugin/; fall back to the repo root
  # for refs pinned to pre-monorepo tags.
  if [ -f "$temp_root/issue-flow/plugin/skills/issue-flow/scripts/bootstrap.cjs" ]; then
    source_dir="$temp_root/issue-flow/plugin"
  else
    source_dir="$temp_root/issue-flow"
  fi
}

resolve_source_dir() {
  dir="$(script_dir)"
  if [ -n "$dir" ] && [ -f "$dir/skills/issue-flow/scripts/bootstrap.cjs" ]; then
    source_dir="$dir"
    return
  fi
  clone_source
}

target="${1:-auto}"
case "$target" in
  -h|--help)
    usage
    exit 0
    ;;
  github|gitlab|auto)
    if [ "$#" -gt 0 ]; then
      shift
    fi
    ;;
  *)
    die "target must be github, gitlab, or auto"
    ;;
esac

require_command node
if [ "$target" = "auto" ] || [ -z "$(script_dir)" ]; then
  require_command git
fi

if [ "$target" = "auto" ]; then
  target="$(detect_target)"
fi

source_dir=""
resolve_source_dir
bootstrap="$source_dir/skills/issue-flow/scripts/bootstrap.cjs"
[ -f "$bootstrap" ] || die "bootstrap script not found: $bootstrap"

node "$bootstrap" "$target" "$@"
