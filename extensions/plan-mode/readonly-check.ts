/**
 * Static shell-command classifier for plan mode.
 *
 * Three outcomes:
 *   allow   - provably read-only (allowlisted command + safe flags)
 *   deny    - provably mutating / dangerous
 *   unknown - cannot decide statically; caller may consult the AI judge
 *
 * Safety bias: whenever segmentation or flag parsing is ambiguous we prefer
 * `deny` or `unknown` over `allow`. Naive splitting inside quotes therefore
 * only ever over-blocks, never under-blocks.
 */

export type VerdictKind = "allow" | "deny" | "unknown";

export interface StaticVerdict {
  kind: VerdictKind;
  /** Human-readable reason, surfaced to the model when blocking. */
  why: string;
}

const allow = (why: string): StaticVerdict => ({ kind: "allow", why });
const deny = (why: string): StaticVerdict => ({ kind: "deny", why });
const unknown = (why: string): StaticVerdict => ({ kind: "unknown", why });

// ---------------------------------------------------------------------------
// Command tables
// ---------------------------------------------------------------------------

/** Unambiguously mutating / dangerous commands. */
const DENY_COMMANDS = new Set([
  // filesystem mutation
  "rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp",
  "ln", "dd", "truncate", "shred", "install", "rsync", "unlink", "mkfifo",
  "mktemp", "tee",
  // privilege escalation
  "sudo", "su", "doas",
  // shells / eval
  "eval", "exec", "source", ".", "sh", "bash", "zsh", "fish", "dash", "ksh",
  // interactive editors (also hang the tool)
  "vim", "vi", "nano", "emacs", "pico", "ed", "code", "open",
  // process / system control
  "kill", "pkill", "killall", "systemctl", "launchctl", "service",
  "shutdown", "reboot", "mount", "umount", "diskutil", "csrutil",
  // package managers
  "apt", "apt-get", "yum", "dnf", "pacman", "zypper", "snap",
  "gem", "composer", "poetry", "pipenv", "conda", "asdf", "nvm",
  // vcs mutation (non-git)
  "svn", "hg",
  // network write / download
  "wget", "scp", "sftp", "ftp", "nc", "netcat", "telnet",
  // archives (extraction writes files)
  "unzip", "zip", "gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "7z", "7za",
  // misc
  "crontab", "defaults", "softwareupdate", "xattr", "codesign",
]);

/** Provably read-only commands. */
const READONLY_COMMANDS = new Set([
  // navigation / filesystem info
  "ls", "pwd", "cd", "pushd", "popd", "dirs", "tree", "stat", "file",
  "du", "df", "basename", "dirname", "realpath", "readlink", "find", "fd",
  "mdfind", "locate",
  // reading
  "cat", "head", "tail", "bat", "nl", "strings", "xxd", "od", "hexdump", "less", "more",
  // searching
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "ripgrep",
  // text processing
  "wc", "sort", "uniq", "cut", "tr", "awk", "jq", "yq", "column", "diff",
  "comm", "paste", "fold", "rev", "expand", "unexpand", "join", "sed",
  "base64", "md5", "md5sum", "shasum", "sha256sum", "cksum",
  // environment / info
  "echo", "printf", "date", "env", "printenv", "whoami", "hostname", "uname",
  "id", "groups", "which", "whereis", "type", "command", "true", "false",
  "test", "seq", "yes_", "uptime", "sw_vers", "arch", "tty", "logname",
  "ps", "top_", "lsof", "netstat", "ifconfig", "sleep",
  "man", "help", "info", "whatis", "apropos",
  "plutil", "sysctl", "ioreg", "system_profiler",
]);

/**
 * Commands whose safety depends on the subcommand.
 * `ro` = read-only subcommands. Anything else -> deny.
 */
const SUBCOMMAND_READONLY: Record<string, Set<string>> = {
  git: new Set([
    "status", "log", "diff", "show", "blame", "annotate", "ls-files", "ls-tree",
    "ls-remote", "rev-parse", "rev-list", "describe", "shortlog", "reflog",
    "cat-file", "name-rev", "whatchanged", "cherry", "count-objects",
    "branch", "tag", "remote", "config", "stash", "worktree", "submodule",
    "verify-pack", "grep", "version", "help", "var", "check-ignore",
    "check-attr", "diff-tree", "diff-index", "diff-files", "merge-base",
    "symbolic-ref", "for-each-ref", "show-ref", "show-branch", "bugreport",
  ]),
  npm: new Set(["ls", "list", "view", "info", "show", "outdated", "why", "root", "prefix", "bin", "docs", "repo", "ping", "whoami", "version", "help", "search"]),
  pnpm: new Set(["ls", "list", "why", "outdated", "root", "bin", "licenses", "help"]),
  yarn: new Set(["list", "why", "outdated", "info", "bin", "help"]),
  docker: new Set(["ps", "images", "image", "inspect", "logs", "version", "info", "stats", "port", "top", "diff", "history", "search"]),
  kubectl: new Set(["get", "describe", "logs", "explain", "version", "api-resources", "api-versions", "cluster-info", "top", "config"]),
  pip: new Set(["show", "list", "freeze", "check", "config", "debug", "help"]),
  pip3: new Set(["show", "list", "freeze", "check", "config", "debug", "help"]),
  cargo: new Set(["tree", "metadata", "search", "version", "help", "verify-project", "locate-project", "pkgid", "read-manifest"]),
  brew: new Set(["list", "ls", "info", "deps", "uses", "search", "config", "doctor", "outdated", "--version", "help"]),
  go: new Set(["version", "env", "list", "doc", "vet"]),
  systemctl: new Set(["status", "list-units", "show", "is-active", "is-enabled", "cat"]),
  defaults: new Set(["read", "read-type", "domains", "find"]),
};

/**
 * Commands that take another command as their operand; the real command must be
 * extracted and re-classified.
 */
const WRAPPER_COMMANDS = new Set([
  "xargs", "env", "time", "nice", "nohup", "timeout", "stdbuf", "ionice",
  "command", "builtin", "watch", "parallel",
]);

/** Interpreters: safe for --version, deadly with inline-eval flags. */
const INTERPRETERS = new Set([
  "node", "python", "python2", "python3", "ruby", "perl", "php", "deno",
  "bun", "osascript", "lua", "R", "Rscript",
]);

const INLINE_EVAL_FLAGS = new Set(["-e", "-c", "-p", "-pe", "-ne", "--eval", "--exec", "--print"]);
const VERSION_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h", "--usage"]);

/** Shell keywords that are structural and carry no command by themselves. */
const STRUCTURAL_HEADERS = new Set(["for", "while", "until", "case", "select", "esac", "done", "fi", "then", "in", "do", "else", "function", "{", "}", "(", ")"]);
const TRANSPARENT_KEYWORDS = new Set(["if", "elif", "then", "do", "else", "!", "{", "}", "(", ")"]);

/** Archive list-only flags that make an archive command read-only. */
const ARCHIVE_LIST_FLAGS = new Set(["-t", "--list", "-l", "-tf", "-tvf", "-tzf", "-tjf"]);

// ---------------------------------------------------------------------------
// Quote-aware helpers
// ---------------------------------------------------------------------------

interface Span {
  text: string;
  /** true when the char is inside single or double quotes */
  quoted: boolean;
}

/** Walk a command producing per-character quote state (handles backslash escapes). */
function scan(cmd: string): Span[] {
  const out: Span[] = [];
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "\\" && quote !== "'") {
      out.push({ text: ch, quoted: quote !== null });
      if (i + 1 < cmd.length) {
        out.push({ text: cmd[i + 1]!, quoted: true }); // escaped char is inert
        i++;
      }
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      out.push({ text: ch, quoted: true });
      continue;
    }
    if (quote !== null && ch === quote) {
      quote = null;
      out.push({ text: ch, quoted: true });
      continue;
    }
    out.push({ text: ch, quoted: quote !== null });
  }
  return out;
}

/** Strip `#` comments that appear outside quotes. */
function stripComments(cmd: string): string {
  const spans = scan(cmd);
  let out = "";
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (!s.quoted && s.text === "#") {
      // consume to end of line
      while (i < spans.length && spans[i]!.text !== "\n") i++;
      out += "\n";
      continue;
    }
    out += s.text;
  }
  return out;
}

/**
 * Extract `$(...)` and backtick substitution bodies, returning the bodies plus
 * the command with those regions blanked out.
 */
export function extractSubstitutions(cmd: string): { bodies: string[]; rest: string } {
  const spans = scan(cmd);
  const bodies: string[] = [];
  let rest = "";
  let i = 0;
  while (i < spans.length) {
    const s = spans[i]!;
    // $( ... ) — tracked even inside double quotes, since it still executes
    if (s.text === "$" && i + 1 < spans.length && spans[i + 1]!.text === "(") {
      let depth = 1;
      let body = "";
      let j = i + 2;
      while (j < spans.length && depth > 0) {
        const c = spans[j]!.text;
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) break;
        }
        body += c;
        j++;
      }
      bodies.push(body);
      rest += " __SUBST__ ";
      i = j + 1;
      continue;
    }
    // `...`
    if (s.text === "`") {
      let body = "";
      let j = i + 1;
      while (j < spans.length && spans[j]!.text !== "`") {
        body += spans[j]!.text;
        j++;
      }
      bodies.push(body);
      rest += " __SUBST__ ";
      i = j + 1;
      continue;
    }
    rest += s.text;
    i++;
  }
  return { bodies, rest };
}

/** Split into pipeline/list segments on unquoted `; && || | & newline`. */
export function splitSegments(cmd: string): string[] {
  const spans = scan(cmd);
  const segs: string[] = [];
  let cur = "";
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (s.quoted) {
      cur += s.text;
      continue;
    }
    const next = spans[i + 1]?.text;
    if (s.text === ";" || s.text === "\n") {
      segs.push(cur);
      cur = "";
      continue;
    }
    if ((s.text === "&" && next === "&") || (s.text === "|" && next === "|")) {
      segs.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (s.text === "|" || s.text === "&") {
      segs.push(cur);
      cur = "";
      continue;
    }
    cur += s.text;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Detect a write redirection outside quotes.
 * Safe forms: `>/dev/null`, `2>/dev/null`, `2>&1`, `>&2`, `<` (input).
 */
export function findWriteRedirect(seg: string): string | null {
  const spans = scan(seg);
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (s.quoted || s.text !== ">") continue;
    let j = i + 1;
    if (spans[j]?.text === ">") j++; // >>
    while (j < spans.length && /\s/.test(spans[j]!.text)) j++;
    // >&N is a descriptor dup, harmless
    if (spans[j]?.text === "&") continue;
    let target = "";
    while (j < spans.length && !/\s/.test(spans[j]!.text)) {
      target += spans[j]!.text;
      j++;
    }
    if (target === "/dev/null" || target === "/dev/stdout" || target === "/dev/stderr") continue;
    return target || ">";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

/** Split a single segment into tokens, dropping quote characters. */
function tokenize(seg: string): string[] {
  const spans = scan(seg);
  const tokens: string[] = [];
  let cur = "";
  let sawQuote = false;
  for (const s of spans) {
    if (!s.quoted && /\s/.test(s.text)) {
      if (cur || sawQuote) tokens.push(cur);
      cur = "";
      sawQuote = false;
      continue;
    }
    if (s.text === '"' || s.text === "'" || s.text === "\\") {
      sawQuote = true;
      continue;
    }
    cur += s.text;
  }
  if (cur || sawQuote) tokens.push(cur);
  return tokens;
}

/** Remove redirection tokens so they don't get mistaken for the command. */
function stripRedirections(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\d*(>>?|<)/.test(t) && t !== "-") {
      // token is a redirection; if the target is a separate token, drop it too
      if (/^\d*(>>?|<)$/.test(t)) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

function stripEnvAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens.slice(i);
}

function stripStructural(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && TRANSPARENT_KEYWORDS.has(tokens[i]!)) i++;
  return tokens.slice(i);
}

/** `/usr/bin/git` -> `git` */
function baseName(cmd: string): string {
  const idx = cmd.lastIndexOf("/");
  return idx === -1 ? cmd : cmd.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Per-command flag audits
// ---------------------------------------------------------------------------

function auditFlags(name: string, args: string[]): StaticVerdict | null {
  switch (name) {
    case "find":
    case "fd": {
      const bad = args.find((a) =>
        ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls", "-x", "--exec"].includes(a),
      );
      if (bad) return deny(`\`${name}\` with ${bad} can execute or delete`);
      return null;
    }
    case "sed": {
      for (const a of args) {
        if (a === "--in-place" || a.startsWith("--in-place=")) return deny("`sed --in-place` rewrites files");
        if (a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes("i")) {
          return deny(`\`sed ${a}\` edits files in place`);
        }
      }
      return null;
    }
    case "perl":
    case "ruby": {
      if (args.some((a) => a.startsWith("-i"))) return deny(`\`${name} -i\` edits files in place`);
      return null;
    }
    case "sort": {
      if (args.some((a) => a === "-o" || a === "--output" || a.startsWith("--output="))) {
        return deny("`sort -o` writes to a file");
      }
      return null;
    }
    case "awk":
    case "gawk": {
      const prog = args.find((a) => !a.startsWith("-"));
      if (prog && (prog.includes(">") || prog.includes("system(") || prog.includes("close(") || prog.includes("|"))) {
        return deny("awk program contains redirection or system()");
      }
      if (args.some((a) => a.startsWith("-i"))) return deny("`awk -i` loads/writes files");
      return null;
    }
    case "curl": {
      const bad = args.find((a) =>
        ["-o", "-O", "--output", "--remote-name", "-T", "--upload-file", "-d", "--data", "--data-raw", "-F", "--form"].includes(a),
      );
      if (bad) return deny(`\`curl ${bad}\` writes a file or sends a body`);
      const m = args.indexOf("-X");
      if (m !== -1 && args[m + 1] && !/^(GET|HEAD|OPTIONS)$/i.test(args[m + 1]!)) {
        return deny(`\`curl -X ${args[m + 1]}\` mutates remote state`);
      }
      return null;
    }
    case "ps":
    case "lsof":
    case "netstat":
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Segment classification
// ---------------------------------------------------------------------------

function classifySegment(seg: string, extraReadOnly: Set<string>): StaticVerdict {
  const redirect = findWriteRedirect(seg);
  if (redirect) return deny(`writes to \`${redirect}\` via redirection`);

  let tokens = stripRedirections(tokenize(seg));
  tokens = stripStructural(tokens);
  tokens = stripEnvAssignments(tokens);
  if (tokens.length === 0) return allow("no command (structural or assignment only)");

  let name = baseName(tokens[0]!);
  let args = tokens.slice(1);

  // `for f in ...` / `while ...` headers execute nothing themselves
  if (STRUCTURAL_HEADERS.has(name)) return allow(`shell keyword \`${name}\``);
  if (name === "__SUBST__") return allow("command substitution (checked separately)");

  // Unwrap wrapper commands (xargs / env / timeout / ...)
  let guard = 0;
  while (WRAPPER_COMMANDS.has(name) && guard++ < 5) {
    // xargs with no command defaults to echo; but `xargs rm` must be caught
    let k = 0;
    while (k < args.length) {
      const a = args[k]!;
      if (a.startsWith("-")) {
        // flags that consume a value
        if (["-n", "-P", "-I", "-i", "-L", "-s", "-d", "-E", "--max-args", "--max-procs", "--replace", "--delimiter"].includes(a)) k += 2;
        else k += 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { k++; continue; }
      if (/^\d+(\.\d+)?[smhd]?$/.test(a)) { k++; continue; } // timeout duration
      break;
    }
    const inner = args.slice(k);
    if (inner.length === 0) {
      return name === "env" || name === "printenv"
        ? allow("`env` with no command prints the environment")
        : allow(`\`${name}\` with no operand command`);
    }
    name = baseName(inner[0]!);
    args = inner.slice(1);
  }

  // Subcommand-gated commands are checked BEFORE the deny list, because some
  // (systemctl, defaults) are dangerous in general but have read-only verbs.
  const subRules = SUBCOMMAND_READONLY[name];
  if (subRules) return classifySubcommand(name, args, subRules);

  // Hard denies
  if (DENY_COMMANDS.has(name)) {
    // archives are read-only in list mode
    if (["tar", "unzip", "zip", "7z", "7za"].includes(name) && args.some((a) => ARCHIVE_LIST_FLAGS.has(a))) {
      return allow(`\`${name}\` in list mode`);
    }
    if (name === "wget" && args.includes("-O") && args[args.indexOf("-O") + 1] === "-") {
      return unknown("`wget -O -` streams to stdout; network read");
    }
    return deny(`\`${name}\` is a mutating or unsafe command`);
  }

  // tar: deny unless list mode (tar isn't in DENY_COMMANDS to allow -t)
  if (name === "tar") {
    if (args.some((a) => ARCHIVE_LIST_FLAGS.has(a) || /^-[a-z]*t[a-z]*$/.test(a))) {
      return allow("`tar` in list mode");
    }
    return deny("`tar` extracts or creates archives");
  }

  // Interpreters
  if (INTERPRETERS.has(name)) {
    const evalFlag = args.find((a) => INLINE_EVAL_FLAGS.has(a));
    if (evalFlag) return deny(`\`${name} ${evalFlag}\` runs arbitrary inline code`);
    if (args.length === 0 || args.every((a) => VERSION_FLAGS.has(a))) {
      return allow(`\`${name}\` version/help query`);
    }
    return unknown(`\`${name}\` runs a script whose effects are unknown`);
  }

  // Plain allowlist
  if (READONLY_COMMANDS.has(name) || extraReadOnly.has(name)) {
    const flagAudit = auditFlags(name, args);
    if (flagAudit) return flagAudit;
    return allow(`\`${name}\` is read-only`);
  }

  // curl / others we have opinions about but aren't allowlisted
  if (name === "curl") {
    const flagAudit = auditFlags(name, args);
    if (flagAudit) return flagAudit;
    return unknown("`curl` performs network access");
  }

  return unknown(`\`${name}\` is not in the read-only allowlist`);
}

/** Classify a command whose safety depends on its subcommand. */
function classifySubcommand(name: string, args: string[], subRules: Set<string>): StaticVerdict {
  // skip global flags (e.g. `git -C dir log`, `git -c k=v log`)
  let k = 0;
  while (k < args.length && args[k]!.startsWith("-")) {
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--context"].includes(args[k]!)) k += 2;
    else k += 1;
  }
  const sub = args[k];
  if (!sub) {
    if (name === "git" || name === "defaults" || name === "systemctl") {
      return allow(`\`${name}\` with no subcommand only prints usage`);
    }
    return allow(`\`${name}\` with no subcommand only prints usage`);
  }
  const subArgs = args.slice(k + 1);
  if (!subRules.has(sub)) {
    return deny(`\`${name} ${sub}\` is not a known read-only subcommand`);
  }

  // Subcommands that are read-only only in their listing form.
  if (name === "git" && (sub === "branch" || sub === "tag")) {
    const mutating = subArgs.find(
      (a) => /^-(d|D|m|M|f)$/.test(a) || ["--delete", "--move", "--force", "--create-reflog", "--edit-description", "--set-upstream-to", "--unset-upstream"].includes(a),
    );
    if (mutating) return deny(`\`git ${sub} ${mutating}\` mutates refs`);
    const positional = subArgs.filter((a) => !a.startsWith("-"));
    if (positional.length > 0) return deny(`\`git ${sub} ${positional[0]}\` creates a ref`);
  }
  if (name === "git" && sub === "config") {
    const ok = subArgs.some((a) => a === "--get" || a === "--get-all" || a === "--get-regexp" || a === "--list" || a === "-l");
    if (!ok) return deny("`git config` without --get/--list writes config");
  }
  if (name === "git" && sub === "stash") {
    const s2 = subArgs.find((a) => !a.startsWith("-"));
    if (s2 !== "list" && s2 !== "show") return deny("`git stash` only allows `list`/`show`");
  }
  if (name === "git" && sub === "remote") {
    const ok = subArgs.length === 0 || subArgs.every((a) => a === "-v" || a === "--verbose" || a === "show" || !a.startsWith("-") === false);
    const verb = subArgs.find((a) => !a.startsWith("-"));
    if (verb && verb !== "show") return deny(`\`git remote ${verb}\` mutates remotes`);
    if (!ok && !verb) return deny("`git remote` subcommand may mutate remotes");
  }
  if (name === "git" && sub === "worktree") {
    const verb = subArgs.find((a) => !a.startsWith("-"));
    if (verb !== "list") return deny("`git worktree` only allows `list`");
  }
  if (name === "git" && sub === "submodule") {
    const verb = subArgs.find((a) => !a.startsWith("-"));
    if (verb !== "status" && verb !== "summary") return deny("`git submodule` only allows `status`/`summary`");
  }
  if (name === "kubectl" && sub === "config") {
    const verb = subArgs.find((a) => !a.startsWith("-"));
    if (!verb || !(verb.startsWith("view") || verb.startsWith("get-"))) {
      return deny("`kubectl config` can modify kubeconfig");
    }
  }
  if (name === "npm" && sub === "version" && subArgs.some((a) => !a.startsWith("-"))) {
    return deny("`npm version <x>` writes package.json and tags");
  }
  if (name === "docker" && sub === "image") {
    const verb = subArgs.find((a) => !a.startsWith("-"));
    if (verb !== "ls" && verb !== "inspect" && verb !== "history") return deny("`docker image` subcommand may mutate");
  }

  const flagAudit = auditFlags(name, subArgs);
  if (flagAudit) return flagAudit;
  return allow(`\`${name} ${sub}\` is read-only`);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Classify a shell command as read-only / mutating / undecidable.
 * `deny` beats `unknown` beats `allow` across all segments and substitutions.
 */
export function classifyCommand(cmd: string, extraReadOnly: string[] = []): StaticVerdict {
  const extra = new Set(extraReadOnly);
  const cleaned = stripComments(cmd).trim();
  if (!cleaned) return allow("empty command");

  const { bodies, rest } = extractSubstitutions(cleaned);

  let worst: StaticVerdict = allow("all segments read-only");

  const consider = (v: StaticVerdict) => {
    if (v.kind === "deny") {
      if (worst.kind !== "deny") worst = v;
      return;
    }
    if (v.kind === "unknown" && worst.kind === "allow") worst = v;
  };

  // Substitution bodies execute too — recurse.
  for (const body of bodies) {
    const inner = classifyCommand(body, extraReadOnly);
    if (inner.kind === "deny") consider(deny(`command substitution: ${inner.why}`));
    else if (inner.kind === "unknown") consider(unknown(`command substitution: ${inner.why}`));
  }

  for (const seg of splitSegments(rest)) {
    consider(classifySegment(seg, extra));
  }

  return worst;
}
