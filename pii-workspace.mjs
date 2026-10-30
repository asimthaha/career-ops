/**
 * pii-workspace.mjs — optional on-disk tokenization for interactive AI CLIs.
 *
 * WHAT THIS IS FOR
 * ----------------
 * `lib/privacy-guard.mjs` + `lib/pii-interceptor.mjs` guard the requests
 * career-ops itself makes. They cannot see a CLI agent — Claude Code, OpenCode,
 * Codex — reading `cv.md` and `config/profile.yml` from disk with its own file
 * tools. This tool is the manual companion for that gap: it rewrites the chosen
 * user-layer files with placeholder tokens before a CLI session, and puts the
 * real values back afterwards, so the files on disk hold no PII while the CLI
 * is reading them.
 *
 *   node pii-workspace.mjs status    # is each file tokenized or holding real PII?
 *   node pii-workspace.mjs scrub     # replace configured values with tokens
 *   node pii-workspace.mjs restore    # put the real values back
 *
 * CAVEATS — read before using scrub
 * ---------------------------------
 * `scrub` MUTATES YOUR CV AND PROFILE IN PLACE. A crash, a lost laptop or a
 * forgotten `restore` leaves those files tokenized, and the tokens are only
 * reversible while `.pii-token-map.json` exists. Run `restore` when the session
 * ends. Tokens are also only as good as the configured values: rename a value in
 * `config/privacy.yml` and the old tokens no longer map to it.
 *
 * The token map is written to the data root and gitignored; it holds your real
 * values, so treat it exactly as you treat `cv.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import {
  loadPrivacyGuard,
  readPrivacyConfig,
  getPrivacyConfigPath,
} from './lib/privacy-guard.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { acquireDirLock, releaseOrWarn } from './lib/dir-lock.mjs';

const USER_FILES = ['cv.md', 'config/profile.yml', 'modes/_profile.md'];
const TOKEN_MAP_NAME = '.pii-token-map.json';

const root = getCareerOpsRoot();
const tokenMapPath = path.join(root, TOKEN_MAP_NAME);

/** Escape a literal so it can be used inside a RegExp. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function loadTokenMap() {
  if (!fs.existsSync(tokenMapPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenMapPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid token map structure');
    }
    return parsed;
  } catch (err) {
    console.error(`[privacy] Error reading token map at ${tokenMapPath}: ${err.message}`);
    process.exit(1);
  }
}

function atomicWriteFileSync(targetPath, content, options = {}) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  const opts = typeof options === 'string' ? { encoding: options } : { ...options };

  let mode = opts.mode;
  if (mode === undefined && fs.existsSync(targetPath)) {
    try {
      mode = fs.statSync(targetPath).mode & 0o777;
    } catch {
      /* ignore */
    }
  }
  if (mode === undefined) {
    mode = 0o600;
  }

  const tempPath = path.join(
    dir,
    `.tmp-${path.basename(targetPath)}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  let renamed = false;
  try {
    fs.writeFileSync(tempPath, content, { ...opts, mode });
    try {
      fs.chmodSync(tempPath, mode);
    } catch {
      /* on Windows chmod is limited, ignore chmod failures */
    }
    fs.renameSync(tempPath, targetPath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        /* ignore cleanup failures */
      }
    }
  }
}

function saveTokenMap(map) {
  atomicWriteFileSync(tokenMapPath, JSON.stringify(map, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Replace each configured text value in `text` with a stable token.
 * `map` is token -> real value and is merged across files.
 */
function scrub(text, guard, map) {
  let out = text;
  let maxIndex = 0;
  for (const token of Object.keys(map)) {
    const match = token.match(/PRIVACY_VALUE_(\d+)/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxIndex) maxIndex = n;
    }
  }
  let index = maxIndex;

  for (const value of guard.textValues) {
    if (value.length < 5) continue;
    const re = new RegExp(escapeRe(value), 'gi');
    out = out.replace(re, (matched) => {
      // Reuse an existing token only when the spelling and casing match exactly.
      const existing = Object.entries(map).find(([, v]) => v === matched);
      if (existing) return existing[0];
      // Use an identifier valid as an unquoted YAML scalar (no braces).
      const token = `PRIVACY_VALUE_${++index}`;
      map[token] = matched;
      return token;
    });
  }
  return out;
}

function rehydrate(text, map) {
  if (!map || Object.keys(map).length === 0) return text;

  // Match complete numeric tokens (PRIVACY_VALUE_\d+) and legacy tokens in a
  // single replacement pass over the original text, looking up each exact match
  // in map. Descending length order for legacy tokens prevents shorter tokens
  // corrupting longer ones, and a single pass ensures inserted values are not
  // processed again.
  const extraTokens = Object.keys(map)
    .filter((k) => !/^PRIVACY_VALUE_\d+$/.test(k))
    .sort((a, b) => b.length - a.length);

  const pattern = new RegExp(
    [...extraTokens.map(escapeRe), 'PRIVACY_VALUE_\\d+'].join('|'),
    'g'
  );

  return text.replace(pattern, (matched) => {
    return Object.prototype.hasOwnProperty.call(map, matched) ? map[matched] : matched;
  });
}

async function main() {
  const mode = process.argv[2]; // 'scrub' | 'restore' | 'status'

  if (!mode || !['scrub', 'restore', 'status'].includes(mode)) {
    console.log(`Usage: node pii-workspace.mjs <scrub|restore|status>`);
    process.exit(1);
  }

  let guard = null;

  if (mode === 'scrub') {
    const config = readPrivacyConfig();
    if (config.source === 'empty' || config.source === 'absent') {
      console.log(
        `[privacy] No configured values found (${config.source === 'absent' ? 'config/privacy.yml is absent' : 'config/privacy.yml is empty'}).\n` +
          `          Copy config/privacy.example.yml to config/privacy.yml and fill it in first.\n` +
          `          Path checked: ${getPrivacyConfigPath()}`
      );
      process.exit(1);
    }

    // Use an empty env so scrub mode is never disabled by an outbound LLM bypass.
    guard = loadPrivacyGuard({ config, env: {} });
    const numericCount = (guard.digitStrings?.size ?? 0) + (guard.digitRuns?.size ?? 0);
    const textCount = guard.textValues?.size ?? 0;
    if (textCount === 0 && numericCount === 0) {
      console.error(
        `[privacy] No guardable values loaded. Check config/privacy.yml (minimum text length: 5 characters, 5 digits).`
      );
      process.exit(1);
    }
    if (numericCount > 0) {
      console.warn(
        `[privacy] WARNING: ${numericCount} configured numeric value(s) cannot be tokenized and remain readable.`
      );
    }
  }

  let lock = null;
  if (mode === 'scrub' || mode === 'restore') {
    lock = await acquireDirLock(`${tokenMapPath}.lock`, {
      timeoutMs: 10_000,
      retryMs: 50,
      staleMs: 30_000,
      createParent: true,
    });
  }

  try {
    const map = loadTokenMap();

    for (const file of USER_FILES) {
      const filePath = path.join(root, file);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');

      if (mode === 'scrub') {
        const scrubbed = scrub(content, guard, map);
        if (scrubbed !== content) {
          // Persist the token map immediately before each rewritten file loses its real values.
          saveTokenMap(map);
          atomicWriteFileSync(filePath, scrubbed, 'utf8');
        }
        console.log(`[privacy] ${file}: tokenized (${Object.keys(map).length} token(s) mapped)`);
      } else if (mode === 'restore') {
        const restored = rehydrate(content, map);
        if (restored !== content) atomicWriteFileSync(filePath, restored, 'utf8');
        const unresolved = restored.match(/PRIVACY_VALUE_\d+/g);
        if (unresolved && unresolved.length > 0) {
          const unique = [...new Set(unresolved)];
          console.warn(
            `[privacy] WARNING: ${file} still contains ${unique.length} unresolved token(s): ${unique.join(', ')}`
          );
        } else {
          console.log(`[privacy] ${file}: real values restored`);
        }
      } else {
        const hasTokens = /PRIVACY_VALUE_|PRIVACY_REDACTED_|CANDIDATE_/.test(content);
        console.log(`[privacy] ${file}: ${hasTokens ? 'contains tokens' : 'no tokens detected'}`);
      }
    }

    if (mode === 'scrub' && Object.keys(map).length > 0) saveTokenMap(map);
  } finally {
    if (lock) releaseOrWarn(lock);
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}

export {
  USER_FILES,
  TOKEN_MAP_NAME,
  loadTokenMap,
  atomicWriteFileSync,
  saveTokenMap,
  scrub,
  rehydrate,
  main,
};
