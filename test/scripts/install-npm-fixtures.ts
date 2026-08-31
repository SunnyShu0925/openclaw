// NPM CLI fixture writers used by installer shell-script tests.
import { chmodSync, writeFileSync } from "node:fs";

export function writeNpmInstallRetryFixture(path: string) {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then printf "11.15.0\\n"; exit 0; fi',
      'if [[ "${1:-}" == "config" ]]; then printf "null\\n"; exit 0; fi',
      'if [[ "${1:-}" == "view" ]]; then printf "2026.8.1\\n"; exit 0; fi',
      'if [[ "${1:-}" == "root" ]]; then printf "%s\\n" "${NPM_FAKE_ROOT:-}"; exit 0; fi',
      "is_install=0",
      'for arg in "$@"; do [[ "$arg" == "install" ]] && is_install=1; done',
      'if [[ "$is_install" -eq 0 ]]; then exit 0; fi',
      'spec="${!#}"',
      'printf "%s\\n" "$spec" >> "$NPM_FAKE_CALLS"',
      'attempt="$(awk \'END { print NR }\' "$NPM_FAKE_CALLS")"',
      'if [[ "$NPM_FAKE_OUTCOME" == "success" || "$NPM_FAKE_OUTCOME" == "transient" && "$attempt" -eq 2 ]]; then',
      '  if [[ -n "${NPM_FAKE_PACKAGE_DIR:-}" ]]; then',
      '    mkdir -p "$NPM_FAKE_PACKAGE_DIR/dist"',
      '    printf "#!/bin/sh\\nprintf \'2026.8.1\\\\n\'\\n" > "$NPM_FAKE_PACKAGE_DIR/openclaw.mjs"',
      '    printf "#!/usr/bin/env node\\n" > "$NPM_FAKE_PACKAGE_DIR/dist/entry.js"',
      '    chmod +x "$NPM_FAKE_PACKAGE_DIR/openclaw.mjs" "$NPM_FAKE_PACKAGE_DIR/dist/entry.js"',
      "  fi",
      "  exit 0",
      "fi",
      'printf "%s (attempt %s)\\n" "$NPM_FAKE_ERROR" "$attempt" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

export function writeNpmFreshnessConflictFixture(path: string, argsLog: string) {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then printf "11.15.0\\n"; exit 0; fi',
      `printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "min-release-age" ]]; then',
      "  printf 'null\\n'",
      "  exit 0",
      "fi",
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "before" ]]; then',
      "  printf 'Wed May 13 2026 21:25:20 GMT-0300 (Brasilia Standard Time)\\n'",
      "  exit 0",
      "fi",
      'for arg in "$@"; do',
      '  if [[ "$arg" == --before=* ]]; then',
      "    printf '%s\\n' 'Exit prior to config file resolving' >&2",
      "    printf '%s\\n' 'cause' >&2",
      "    printf '%s\\n' '--min-release-age cannot be provided when using --before' >&2",
      "    exit 64",
      "  fi",
      "done",
      'for arg in "$@"; do',
      '  if [[ "$arg" == "--min-release-age=0" ]]; then',
      "    exit 0",
      "  fi",
      "done",
      "exit 65",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

export function writeNpmBeforePolicyFixture(path: string, argsLog: string) {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then printf "11.15.0\\n"; exit 0; fi',
      `printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "min-release-age" ]]; then',
      "  printf 'null\\n'",
      "  exit 0",
      "fi",
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "before" ]]; then',
      "  printf 'Wed May 13 2026 21:25:20 GMT-0300 (Brasilia Standard Time)\\n'",
      "  exit 0",
      "fi",
      'for arg in "$@"; do',
      '  if [[ "$arg" == "--min-release-age=0" ]]; then',
      "    printf '%s\\n' 'min-release-age should not be selected for project-only npmrc' >&2",
      "    exit 64",
      "  fi",
      "done",
      'for arg in "$@"; do',
      '  if [[ "$arg" == --before=* ]]; then',
      "    exit 0",
      "  fi",
      "done",
      "exit 65",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

export function writeNpmEexistRecoveryFixture(path: string, argsLog: string) {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then printf "11.15.0\\n"; exit 0; fi',
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "min-release-age" ]]; then printf "null\\n"; exit 0; fi',
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "before" ]]; then printf "null\\n"; exit 0; fi',
      'if [[ "$1" == "view" ]]; then printf "2026.8.1\\n"; exit 0; fi',
      'if [[ "$1" == "root" ]]; then printf "%s\\n" "${NPM_FAKE_ROOT:-}"; exit 0; fi',
      'if [[ "$1" == "prefix" ]]; then printf "%s\\n" "${NPM_FAKE_PREFIX:-}"; exit 0; fi',
      "is_install=0",
      'for arg in "$@"; do [[ "$arg" == "install" ]] && is_install=1; done',
      'if [[ "$is_install" -eq 0 ]]; then exit 0; fi',
      `printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
      `attempt="$(awk 'END { print NR }' ${JSON.stringify(argsLog)})"`,
      "if (( attempt == 1 )); then",
      "  # --silent is npm's alias for --loglevel silent: it blanks the captured log,",
      "  # so the EEXIST recovery that greps over that log never fires.",
      "  has_silent=0",
      '  for arg in "$@"; do [[ "$arg" == "--silent" ]] && has_silent=1; done',
      '  if [[ "$has_silent" -eq 0 ]]; then',
      '    printf "npm error code EEXIST\\n" >&2',
      '    printf "npm error path %s/openclaw\\n" "${NPM_FAKE_PREFIX:-}/bin" >&2',
      '    printf "npm error EEXIST: file already exists\\n" >&2',
      '    printf "npm error File exists: %s/bin/openclaw\\n" "${NPM_FAKE_PREFIX:-}" >&2',
      "  fi",
      "  exit 1",
      "fi",
      'if [[ -n "${NPM_FAKE_PACKAGE_DIR:-}" ]]; then',
      '  mkdir -p "$NPM_FAKE_PACKAGE_DIR/dist"',
      '  printf "#!/bin/sh\\nprintf \'2026.8.1\\\\n\'\\n" > "$NPM_FAKE_PACKAGE_DIR/openclaw.mjs"',
      '  printf "#!/usr/bin/env node\\n" > "$NPM_FAKE_PACKAGE_DIR/dist/entry.js"',
      '  chmod +x "$NPM_FAKE_PACKAGE_DIR/openclaw.mjs" "$NPM_FAKE_PACKAGE_DIR/dist/entry.js"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

export function writeNpmEnotemptyRecoveryFixture(path: string, argsLog: string) {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then printf "11.15.0\\n"; exit 0; fi',
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "min-release-age" ]]; then printf "null\\n"; exit 0; fi',
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "before" ]]; then printf "null\\n"; exit 0; fi',
      'if [[ "$1" == "view" ]]; then printf "2026.8.1\\n"; exit 0; fi',
      'if [[ "$1" == "root" ]]; then printf "%s\\n" "${NPM_FAKE_ROOT:-}"; exit 0; fi',
      'if [[ "$1" == "prefix" ]]; then printf "%s\\n" "${NPM_FAKE_PREFIX:-}"; exit 0; fi',
      "is_install=0",
      'for arg in "$@"; do [[ "$arg" == "install" ]] && is_install=1; done',
      'if [[ "$is_install" -eq 0 ]]; then exit 0; fi',
      `printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
      `attempt="$(awk 'END { print NR }' ${JSON.stringify(argsLog)})"`,
      "if (( attempt == 1 )); then",
      "  # --silent is npm's alias for --loglevel silent: it blanks the captured log,",
      "  # so the ENOTEMPTY recovery that greps over that log never fires.",
      "  has_silent=0",
      '  for arg in "$@"; do [[ "$arg" == "--silent" ]] && has_silent=1; done',
      '  if [[ "$has_silent" -eq 0 ]]; then',
      '    printf "npm error code ENOTEMPTY\\n" >&2',
      '    printf "npm error syscall rename\\n" >&2',
      '    printf "npm error ENOTEMPTY: directory not empty, rename %s/.openclaw-stale -> %s/openclaw\\n" "${NPM_FAKE_ROOT:-}" "${NPM_FAKE_ROOT:-}" >&2',
      "  fi",
      "  exit 1",
      "fi",
      'if [[ -n "${NPM_FAKE_PACKAGE_DIR:-}" ]]; then',
      '  mkdir -p "$NPM_FAKE_PACKAGE_DIR/dist"',
      '  printf "#!/bin/sh\\nprintf \'2026.8.1\\\\n\'\\n" > "$NPM_FAKE_PACKAGE_DIR/openclaw.mjs"',
      '  printf "#!/usr/bin/env node\\n" > "$NPM_FAKE_PACKAGE_DIR/dist/entry.js"',
      '  chmod +x "$NPM_FAKE_PACKAGE_DIR/openclaw.mjs" "$NPM_FAKE_PACKAGE_DIR/dist/entry.js"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

export function writeNpmLifecycleFixture(path: string) {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then',
      '  [[ "${NPM_FAKE_VERSION_STATUS:-0}" == "0" ]] || exit "$NPM_FAKE_VERSION_STATUS"',
      '  printf "%s\\n" "$NPM_FAKE_VERSION"',
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "root" ]]; then printf "%s\\n" "$NPM_FAKE_ROOT"; exit 0; fi',
      'if [[ "${1:-}" == "config" ]]; then printf "null\\n"; exit 0; fi',
      'printf "%s\\n" "$*" >> "$NPM_FAKE_ARGS"',
      'mkdir -p "$NPM_FAKE_PACKAGE_DIR/dist"',
      'printf "#!/usr/bin/env node\\n" > "$NPM_FAKE_PACKAGE_DIR/dist/entry.js"',
      'if [[ "${NPM_FAKE_KEEP_GUARD:-0}" == "1" ]]; then : > "$NPM_FAKE_PACKAGE_DIR/.openclaw-lifecycle-pending"; else rm -f "$NPM_FAKE_PACKAGE_DIR/.openclaw-lifecycle-pending"; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}
