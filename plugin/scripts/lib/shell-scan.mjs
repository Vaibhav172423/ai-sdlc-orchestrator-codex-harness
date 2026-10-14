/**
 * What a shell command writes, removes and patches, read as sh, bash and zsh split it. Quoted text, comments and
 * here-document bodies are data. What the shell runs from them is read again as shell: a command substitution, the
 * string `sh -c` or `eval` runs, and the here-document or piped text a shell reads as its script.
 *
 * `scanShell` returns effects in command order: `{kind: "write", path, tight}` (a redirect, `tee`, `touch`; `tight`
 * when no blank comes before the operator), `{kind: "copy", tool, flags, args}` (`cp`, `mv`, `git mv`),
 * `{kind: "remove", path}` (`rm`, `unlink`, `git rm`, `mv` sources) and `{kind: "patch", text}` (an `apply_patch`
 * run through the shell). Paths are shell words with quotes and backslashes resolved; `$`, globs and braces stay in
 * them, and a command substitution reads `$*`.
 */

/** Past this depth of substitutions and nested shells, the inner text is not read. */
const MAX_DEPTH = 8;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "yash"]);
const RESERVED = new Set(["!", "{", "}", "if", "then", "elif", "else", "fi", "do", "done", "while", "until", "esac", "coproc"]);
const NO_COMMAND = new Set(["for", "select", "case"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/** Commands that run the words after their options as a command; `short`/`long` are the options that take a value. */
const WRAPPERS = {
  sudo: { short: "ugpCDrtUTR", long: ["--user", "--group", "--prompt", "--close-from", "--chdir", "--role", "--type", "--other-user", "--host", "--command-timeout"], assigns: true },
  doas: { short: "uC" },
  env: { short: "uCSP", long: ["--unset", "--chdir", "--split-string"], assigns: true },
  nice: { short: "n", long: ["--adjustment"] },
  nohup: {},
  command: {},
  builtin: {},
  noglob: {},
  nocorrect: {},
  exec: { short: "a" },
  time: { short: "fo", long: ["--format", "--output"] },
  timeout: { short: "sk", long: ["--signal", "--kill-after"], positional: 1 },
  stdbuf: { short: "ioe", long: ["--input", "--output", "--error"] },
  caffeinate: { short: "tw" },
  xargs: { short: "ILnPsdaEJRS", long: ["--max-args", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--max-lines"] },
};

const REDIRECTS = ["&>>", "&>|", "&>!", "&>", ">>|", ">>!", ">>", ">|", ">!", ">&", ">", "<<<", "<<-", "<<", "<>", "<&", "<"];
const WRITES = new Set(["&>>", "&>|", "&>!", "&>", ">>|", ">>!", ">>", ">|", ">!", ">&", ">", "<>"]);
const CONTROLS = [";;&", ";;", ";&", ";|", ";", "&&", "&|", "&!", "&", "||", "|&", "|"];
/** Characters that end an unquoted word. */
const WORD_END = new Set([" ", "\t", "\r", "\n", ";", "&", "|", ")", "<", ">"]);

// ── lexing ──────────────────────────────────────────────────────────────────

/** Index of the `)` that closes the `(` at `i`, quotes skipped, or text.length. */
function balanced(text, i, open = "(", close = ")") {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === "'") { const e = text.indexOf("'", j + 1); j = e === -1 ? text.length : e; }
    else if (c === '"') j = doubleEnd(text, j + 1);
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
  }
  return text.length;
}

function doubleEnd(text, i) {
  for (let j = i; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === '"') return j;
  }
  return text.length;
}

/** Index of the quote that closes a `$'…'` string whose quote is at `i`. */
function ansiEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "'") return j;
  }
  return text.length;
}

function backtickEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "`") return j;
  }
  return text.length;
}

/** A `$(`, `<(`, `>(` or `=(` body starting at `j`: lexed into ctx.subs. Returns the index of its `)`. */
function substitute(text, j, ctx, level) {
  if (level >= MAX_DEPTH) return balanced(text, j - 1);
  const inner = lex(text, j, ")", ctx, level + 1);
  ctx.subs.push({ tokens: inner.tokens, depth: level + 1 });
  return inner.end;
}

/** A backtick substitution at `i`, its body queued in ctx.subs. Returns the index of the closing backtick. */
function backtick(text, i, ctx, level) {
  const end = backtickEnd(text, i);
  if (level < MAX_DEPTH) ctx.subs.push({ text: text.slice(i + 1, end).replace(/\\([`$\\])/g, "$1"), depth: level + 1 });
  return end;
}

/**
 * A `$…` expansion at `i`: `{value, end}`, where `end` is the index after it, or null for a lone `$`. A command
 * substitution and arithmetic read `$*`, since the hook cannot know what they print.
 */
function dollar(text, i, ctx, level) {
  const n = text[i + 1];
  if (n === "(") {
    if (text[i + 2] === "(") return { value: "$*", end: balanced(text, i + 1) + 1 };
    return { value: "$*", end: substitute(text, i + 2, ctx, level) + 1 };
  }
  if (n === "{") {
    const close = balanced(text, i + 1, "{", "}");
    return { value: text.slice(i, close + 1), end: close + 1 };
  }
  return null;
}

/** A double-quoted string's body from `i` to its closing quote (or, with `closed` false, to the end): `{value, end}`. */
function lexDouble(text, i, ctx, level, closed = true) {
  let v = "";
  while (i < text.length) {
    const c = text[i];
    if (closed && c === '"') return { value: v, end: i };
    if (c === "\\") {
      const n = text[i + 1];
      if (n === "\n") { i += 2; continue; }
      if (n === "$" || n === "`" || n === "\\" || (closed && n === '"')) { v += n; i += 2; continue; }
      v += c;
      i++;
      continue;
    }
    if (c === "$") {
      const d = dollar(text, i, ctx, level);
      if (d) { v += d.value; i = d.end; continue; }
    }
    if (c === "`") { i = backtick(text, i, ctx, level) + 1; v += "$*"; continue; }
    v += c;
    i++;
  }
  return { value: v, end: text.length };
}

/** One shell word from `i`: `{value, raw, plain, end}`. `plain`: no quote, escape or expansion in it. */
function lexWord(text, i, ctx, level) {
  const start = i;
  let v = "";
  let plain = true;
  while (i < text.length) {
    const c = text[i];
    if ((c === "<" || c === ">" || c === "=") && i === start && text[i + 1] === "(") {
      i = substitute(text, i + 2, ctx, level) + 1;
      v += "/dev/fd/63";
      plain = false;
      continue;
    }
    if (WORD_END.has(c)) break;
    if (c === "(") {
      if (i === start || /^\(\s*\)/.test(text.slice(i, i + 64))) break;
      // A glob group, zsh qualifier or extglob (`b(a|c)`, `*(.)`, `@(x)`): any text.
      i = balanced(text, i) + 1;
      v += "*";
      plain = false;
      continue;
    }
    if (c === "\\") {
      if (text[i + 1] !== "\n") v += text[i + 1] ?? "";
      i += 2;
      plain = false;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      v += text.slice(i + 1, end);
      i = end + 1;
      plain = false;
      continue;
    }
    if (c === '"' || (c === "$" && text[i + 1] === '"')) {
      const r = lexDouble(text, c === "$" ? i + 2 : i + 1, ctx, level);
      v += r.value;
      i = r.end + 1;
      plain = false;
      continue;
    }
    if (c === "$" && text[i + 1] === "'") {
      const close = ansiEnd(text, i + 1);
      v += `$${text.slice(i + 2, close).replace(/\\([\s\S])/g, "$1")}`;
      i = close + 1;
      plain = false;
      continue;
    }
    if (c === "$") {
      const d = dollar(text, i, ctx, level);
      plain = false;
      if (d) { v += d.value; i = d.end; continue; }
    }
    if (c === "`") {
      i = backtick(text, i, ctx, level) + 1;
      v += "$*";
      plain = false;
      continue;
    }
    v += c;
    i++;
  }
  return { value: v, raw: text.slice(start, Math.min(i, text.length)), plain, end: Math.min(i, text.length) };
}

/** Reads a here-document body that starts at `i`; returns the index of the newline after its delimiter line. */
function readBody(text, i, doc) {
  for (let line = i; line < text.length;) {
    const nl = text.indexOf("\n", line);
    const end = nl === -1 ? text.length : nl;
    const l = text.slice(line, end).replace(/\r$/, "");
    if ((doc.strip ? l.replace(/^\t+/, "") : l) === doc.delim) {
      doc.body = text.slice(i, line);
      return end;
    }
    line = end + 1;
  }
  doc.body = text.slice(i);
  return text.length;
}

/**
 * Tokens of `text` from `from`: words, redirects (`{t: "redir", op, tight, target, doc}`) and control operators.
 * With `stop` set to `)`, lexing ends at the `)` that closes a substitution.
 */
function lex(text, from, stop, ctx, level) {
  const tokens = [];
  const pending = [];
  let parens = 0;
  let test = false;
  let last = null;
  const push = (tok, end) => { tokens.push(tok); last = { tok, end }; };
  const glued = (j) => !!last && last.end === j &&
    (last.tok.t === "word" || last.tok.v === ")" || (last.tok.t === "redir" && last.tok.target !== null));

  const redirect = (j, op, tight) => {
    const tok = { t: "redir", op, tight, target: null, doc: null, arrow: false };
    // `->` and `=>` are code arrows more often than redirects.
    if (tight && op[0] === ">" && (text[j - 1] === "-" || text[j - 1] === "=")) tok.arrow = true;
    let k = j + op.length;
    while (text[k] === " " || text[k] === "\t") k++;
    if (k < text.length && !WORD_END.has(text[k]) && text[k] !== "(" || ((text[k] === "<" || text[k] === ">") && text[k + 1] === "(")) {
      const w = lexWord(text, k, ctx, level);
      if (op === "<<" || op === "<<-") {
        tok.doc = { delim: w.value, strip: op === "<<-", quoted: !w.plain, body: "" };
        pending.push(tok.doc);
      } else tok.target = w.value;
      k = w.end;
    }
    push(tok, k);
    return k;
  };

  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (stop === ")" && c === ")" && parens === 0) return { tokens, end: i };
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\\" && text[i + 1] === "\n") { i += 2; continue; }
    if (c === "\n") {
      push({ t: "op", v: "\n" }, i + 1);
      i++;
      while (pending.length) i = readBody(text, i, pending.shift());
      continue;
    }
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (test && (c === "<" || c === ">" || c === "(" || c === ")" || c === "&" || c === "|")) {
      // Inside `[[ … ]]` these compare and group; nothing is redirected.
      i++;
      continue;
    }
    const procSub = (c === "<" || c === ">") && text[i + 1] === "(";
    if (c === "(" && text[i + 1] === "(") {
      i = balanced(text, i) + 1;
      continue;
    }
    if (c === "(") { parens++; push({ t: "op", v: "(" }, i + 1); i++; continue; }
    if (c === ")") { parens = Math.max(0, parens - 1); push({ t: "op", v: ")" }, i + 1); i++; continue; }
    if (!procSub && (c === "<" || c === ">" || (c === "&" && text[i + 1] === ">"))) {
      const op = REDIRECTS.find((o) => text.startsWith(o, i));
      i = redirect(i, op, glued(i));
      continue;
    }
    if (c === ";" || c === "&" || c === "|") {
      const op = CONTROLS.find((o) => text.startsWith(o, i));
      push({ t: "op", v: op }, i + op.length);
      i += op.length;
      continue;
    }
    const w = lexWord(text, i, ctx, level);
    if (w.end === i) { i++; continue; }
    if (/^\d+$/.test(w.raw) && (text[w.end] === "<" || text[w.end] === ">") && text[w.end + 1] !== "(") {
      const op = REDIRECTS.find((o) => text.startsWith(o, w.end));
      i = redirect(w.end, op, glued(i));
      continue;
    }
    if (w.plain && w.value === "[[") test = true;
    else if (w.plain && w.value === "]]") test = false;
    push({ t: "word", v: w.value, raw: w.raw, plain: w.plain }, w.end);
    i = w.end;
  }
  return { tokens, end: text.length };
}

// ── commands ────────────────────────────────────────────────────────────────

const commandName = (v) => v.slice(v.lastIndexOf("/") + 1).toLowerCase();

function skipOptions(words, k, spec) {
  let positional = spec.positional ?? 0;
  for (; k < words.length; k++) {
    const a = words[k].v;
    if (a === "--") return k + 1;
    if (a.startsWith("--")) {
      if (!a.includes("=") && spec.long?.includes(a)) k++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const j = [...a.slice(1)].findIndex((ch) => spec.short?.includes(ch));
      if (j !== -1 && j === a.length - 2) k++;
      continue;
    }
    if (spec.assigns && ASSIGNMENT.test(words[k].raw)) continue;
    if (positional > 0) { positional--; continue; }
    return k;
  }
  return k;
}

/** Index of the command word of a simple command, past reserved words, assignments and wrappers, or -1. */
function commandAt(words) {
  let k = 0;
  while (k < words.length) {
    const w = words[k];
    if (w.plain && RESERVED.has(w.v)) { k++; continue; }
    if (w.plain && NO_COMMAND.has(w.v)) return -1;
    if (w.plain && w.v === "function") { k += 2; continue; }
    if (ASSIGNMENT.test(w.raw)) { k++; continue; }
    const spec = Object.hasOwn(WRAPPERS, commandName(w.v)) ? WRAPPERS[commandName(w.v)] : null;
    if (!spec) break;
    k = skipOptions(words, k + 1, spec);
  }
  return k < words.length && !words[k].v.startsWith("-") ? k : -1;
}

/** Option words, operands and option values of an argument list; `short`/`long` name the options that take a value. */
function operands(words, short = "", long = []) {
  const flags = [];
  const ops = [];
  const values = {};
  for (let k = 0; k < words.length; k++) {
    const a = words[k].v;
    if (a === "--") { ops.push(...words.slice(k + 1).map((w) => w.v)); break; }
    if (a.startsWith("--")) {
      flags.push(a);
      const eq = a.indexOf("=");
      if (eq !== -1) values[a.slice(0, eq)] = a.slice(eq + 1);
      else if (long.includes(a)) values[a] = words[++k]?.v;
      continue;
    }
    if (a.startsWith("-")) {
      flags.push(a);
      for (let j = 1; j < a.length; j++) {
        if (!short.includes(a[j])) continue;
        values[`-${a[j]}`] = j < a.length - 1 ? a.slice(j + 1) : words[++k]?.v;
        break;
      }
      continue;
    }
    ops.push(a);
  }
  return { flags, ops, values };
}

/** How a shell invocation gets its script: `{code}` for `-c`, `{file}`, or `{stdin}`. */
function shellMode(vals) {
  let dashC = false;
  let dashS = false;
  let k = 0;
  for (; k < vals.length; k++) {
    const a = vals[k];
    if (a === "--" || a === "-") { k++; break; }
    if (a.startsWith("--")) {
      if (a === "--rcfile" || a === "--init-file") k++;
      continue;
    }
    if (/^[-+][A-Za-z]/.test(a)) {
      if (a[0] === "-" && a.includes("c")) dashC = true;
      if (a[0] === "-" && a.includes("s")) dashS = true;
      if (/[oO]$/.test(a)) k++;
      continue;
    }
    break;
  }
  if (dashC) return { code: vals[k] ?? "" };
  return k < vals.length && !dashS ? { file: vals[k] } : { stdin: true };
}

function split(tokens) {
  const cmds = [];
  let cur = { words: [], redirs: [], pipeOut: false };
  const end = () => {
    if (cur.words.length || cur.redirs.length) cmds.push(cur);
    cur = { words: [], redirs: [], pipeOut: false };
  };
  for (const t of tokens) {
    if (t.t === "word") cur.words.push(t);
    else if (t.t === "redir") cur.redirs.push(t);
    else {
      if (t.v === "|" || t.v === "|&") cur.pipeOut = true;
      end();
    }
  }
  end();
  return cmds;
}

function readsStdinAsShell(cmd) {
  if (!cmd) return false;
  const at = commandAt(cmd.words);
  if (at === -1 || !SHELLS.has(commandName(cmd.words[at].v))) return false;
  return !!shellMode(cmd.words.slice(at + 1).map((w) => w.v)).stdin;
}

function add(out, effect) {
  if (effect.path === undefined || (typeof effect.path === "string" && effect.path.length > 0)) out.push(effect);
}

function copy(tool, words, out) {
  const { flags, ops, values } = operands(words, "tS", ["--target-directory", "--suffix"]);
  const dir = values["-t"] ?? values["--target-directory"];
  const args = dir === undefined ? ops : [...ops, dir];
  out.push({ kind: "copy", tool, flags, args });
  if (tool === "mv") for (const p of args.slice(0, -1)) add(out, { kind: "remove", path: p });
}

function git(words, out) {
  let k = 0;
  for (; k < words.length; k++) {
    const a = words[k].v;
    if (a === "-C" || a === "-c" || /^--(?:git-dir|work-tree|namespace|super-prefix|config-env)$/.test(a)) k++;
    else if (!a.startsWith("-")) break;
  }
  const sub = words[k]?.v;
  const rest = words.slice(k + 1);
  if (sub === "rm") {
    const { flags, ops } = operands(rest, "", ["--pathspec-from-file"]);
    const indexOnly = flags.some((f) => f === "--cached" || f === "--dry-run" || /^-[A-Za-z]*n/.test(f));
    if (!indexOnly) for (const p of ops) add(out, { kind: "remove", path: p });
  } else if (sub === "mv") copy("mv", rest, out);
}

function find(words, out, depth) {
  for (let k = 0; k < words.length; k++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[k].v)) continue;
    let e = k + 1;
    while (e < words.length && words[e].v !== ";" && words[e].v !== "+") e++;
    simple({ words: words.slice(k + 1, e), redirs: [] }, out, depth, false);
    k = e;
  }
}

function simple(cmd, out, depth, feedsShell) {
  const { words, redirs } = cmd;
  const at = commandAt(words);
  const name = at === -1 ? null : commandName(words[at].v);
  const args = at === -1 ? [] : words.slice(at + 1);
  const vals = args.map((w) => w.v);
  if (name !== "[[") {
    for (const r of redirs) {
      if (!WRITES.has(r.op) || r.arrow || r.target === null) continue;
      if (r.op === ">&" && /^(?:\d+-?|-|\$.*)$/.test(r.target)) continue;
      add(out, { kind: "write", path: r.target, tight: r.tight });
    }
  }
  const docs = redirs.filter((r) => r.doc).map((r) => r.doc);
  const strings = redirs.filter((r) => r.op === "<<<" && r.target !== null).map((r) => r.target);
  if (name === "apply_patch" || name === "applypatch") {
    // Codex applies a shell apply_patch itself: its text is a patch, never shell.
    for (const text of [...docs.map((d) => d.body), ...strings, ...vals]) out.push({ kind: "patch", text });
    return;
  }
  const mode = name && SHELLS.has(name) ? shellMode(vals) : null;
  if (mode?.code !== undefined) visit(mode.code, out, depth + 1);
  if (mode?.stdin || feedsShell) {
    for (const d of docs) visit(d.body, out, depth + 1);
    for (const s of strings) visit(s, out, depth + 1);
  } else {
    for (const d of docs) if (!d.quoted) bodySubstitutions(d.body, out, depth + 1);
  }
  if (feedsShell) for (const v of vals) visit(v, out, depth + 1);
  if (name === "eval") visit(vals.join(" "), out, depth + 1);
  if (name === "tee") for (const p of operands(args).ops) add(out, { kind: "write", path: p, tight: false });
  else if (name === "touch") for (const p of operands(args, "rtdA", ["--reference", "--date"]).ops) add(out, { kind: "write", path: p, tight: false });
  else if (name === "cp" || name === "mv") copy(name, args, out);
  else if (name === "rm" || name === "unlink") for (const p of operands(args).ops) add(out, { kind: "remove", path: p });
  else if (name === "git") git(args, out);
  else if (name === "find") find(args, out, depth);
}

function run(tokens, out, depth) {
  const cmds = split(tokens);
  cmds.forEach((cmd, n) => simple(cmd, out, depth, cmd.pipeOut && readsStdinAsShell(cmds[n + 1])));
}

function runSubs(ctx, out) {
  for (const s of ctx.subs) {
    if (s.tokens) run(s.tokens, out, s.depth);
    else visit(s.text, out, s.depth);
  }
}

/** The command substitutions of an unquoted here-document body, which the shell runs before the command reads it. */
function bodySubstitutions(body, out, depth) {
  if (!body || depth > MAX_DEPTH) return;
  const ctx = { subs: [] };
  lexDouble(body, 0, ctx, depth, false);
  runSubs(ctx, out);
}

function visit(text, out, depth) {
  if (typeof text !== "string" || !text || depth > MAX_DEPTH) return;
  const ctx = { subs: [] };
  run(lex(text, 0, null, ctx, depth).tokens, out, depth);
  runSubs(ctx, out);
}

export function scanShell(command) {
  const out = [];
  visit(command, out, 0);
  return out;
}
