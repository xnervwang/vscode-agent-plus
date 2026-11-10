#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.
# Source: vscode-agent-plus shared/plugin/hooks/skill_route.py; sync-shared.js copies it, so edit it there.

"""The skill search behind the work plan plugin's route-skills.py hook and its skill_search MCP tool.

Codex lists every skill in each turn's context, but under a budget: with a hundred or more installed, each description
is cut to about fifty characters, and skills the budget cannot hold are dropped from the list without the model being
told. Codex also never sees skills kept outside its own folders. So before each turn the hook that calls this module
searches every installed skill for the user's words and puts the best few, with their full descriptions and paths, in
front of the model. The MCP server's skill_search tool runs the same search with words the model chooses.

The search is by keywords: BM25 over words, four-letter pieces of words and pairs of CJK characters, with a skill's name
counted four times over its description. It needs no network or credentials and is the default. With the
skillRouteVector setting on (off by default) and Codex's model provider Amazon Bedrock,
the search is by meaning instead, through cohere.embed-v4 on the account and region Codex already uses, and any failure
falls back to the keywords. Measured on 540 past requests whose turn opened a skill within its first three tool calls,
the skill it opened was among the top five for 44% by keywords and 55% by meaning.

The index sits in the plugin's data directory. A turn only checks the modification times of what it was built from, and
when one has changed it starts a background process to rebuild the index and searches the old one meanwhile, so no turn
waits for a rebuild.

Standard library only, Python 3.7 or later. It is kept in Agent Plus's shared code so that the Claude
Code plugin can use it as well.
"""
import array
import configparser
import datetime
import hashlib
import hmac
import json
import math
import operator
import os
import pickle
import re
import shlex
import signal
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import codex_home, settings, write_atomic  # noqa: E402

INDEX_DIR = "skill-route"
INDEX_FILE = "index.pickle"
EMBED_CACHE = "embeddings.pickle"
VECTOR_STATE = "vector.json"
LOG_FILE = "route.log"
BUILD_LOCK = "build.lock"
BUILT_AT = "build.started"
INDEX_VERSION = 4

# What the injected block starts with. The VS Code extension (src/user-times.js ROUTE_MARK) finds the block by this
# text in the rollout, Codex's record of the conversation, to show which skills a turn was given.
MARK = "Skills that may fit this message"
# Messages under this many characters ("yes", "go on") are skipped. Measured over 20,114 requests, the cut skips 6.8%
# of them and misses 2.0% of those that loaded a skill.
MIN_CHARS = 6
QUERY_CHARS = 1500       # characters of the message sent to be embedded
KEYWORD_CHARS = 300      # characters of the message the keyword search reads
DOC_CHARS = 2048         # what a skill's text sent to be embedded is cut to
DESC_CHARS = 1024        # Codex's own cut for a description
# Codex cuts a hook's injected text past its additionalContextLimit, counted as bytes / 4. hooks.json gives this hook
# 4,000; the block is kept under this many bytes, with room to spare, by shortening descriptions.
CONTEXT_BYTES = 15000
MAX_COUNT = 10           # the most skills a turn is given, whatever skillRouteCount says
BUDGET = 1.5             # seconds for the whole hook, network included
CREDENTIAL_TIMEOUT = 1.0
CREDENTIAL_BYTES = 64 * 1024
LOG_MAX = 256 * 1024     # bytes before the log is rotated, keeping one older file
OFF_SECONDS = 6 * 3600   # how long the vector search stays off after a failure that will not go away by itself
BUILD_STALE = 120        # seconds after which a rebuild still holding the lock is taken to have died
BUILD_GAP = 60           # seconds between two rebuilds started by turns
RETRY_VECTORS = 600      # seconds between rebuilds started only to fill in missing vectors
REPOS_KEPT = 8           # repositories whose own skills are kept in one index
SCAN_DEPTH = 3
SCAN_MAX_DIRS = 4000
FRONTMATTER_BYTES = 64 * 1024
EMBED_BATCH = 96         # texts per request; the model takes no more
EMBED_MODEL = "cohere.embed-v4:0"
SEARCH_COUNT_MAX = 20    # the most skills one skill_search call returns

# Keyword search: field weights and the BM25 constants, tuned on the 540 past requests above.
W_NAME, W_TRIGGER, W_DESC = 4.0, 1.0, 1.0
K1, B = 1.2, 0.75
NGRAM, NGRAM_WEIGHT = 4, 0.6
# A word said many times in one message counts at most this much: repeating a word is not asking for it harder.
QUERY_TF_MAX = 1 + math.log(2)
STOP = set("""a an the of to in on for and or is are be it this that with as by at from you your i me my we our use when
how what which who why can do does did not no yes if then than into about one two get set run make need want like just
please help so any all some there here was were been being have has had will would should could may might also its
ok okay thanks thank sure go on other another think fine now done good great right yeah""".split())
# Pairs of characters that turn up in Chinese requests of every kind: matching one says nothing about which skill fits.
CJK_STOP = set("""一下 一个 这个 那个 怎么 什么 为什么 帮我 我们 你们 他们 可以 能不 不能 是不 不是 就是 还是 如果 然后 因为
所以 现在 已经 没有 这样 那样 继续 好的 谢谢 看看 看一 一看 一些 这些 那些 的话 我的 你的 一样 时候 问题 东西 需要 知道
觉得 应该 是否 有没 没什 做一 做吧 吧我 下这 下那 下吧""".split())
CJK = re.compile(u"[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]+")
WORD = re.compile(r"[a-z0-9][a-z0-9_.+/-]*[a-z0-9]|[a-z0-9]")
CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
MENTION = re.compile(r"(?<![\w$])\$([A-Za-z0-9][\w.:-]*)")
TRIGGER = re.compile(r"(?:Use when|Use it when|Use for|Use on|Use immediately after|Use after|Use whenever|Triggers on)\b(.*)$",
                     re.S)


def data_root(directory):
    return os.path.join(directory, INDEX_DIR)


"""Reading config.toml.

Python 3.7 has no TOML parser, and the values wanted here are plain: strings, arrays, booleans and integers, in tables,
arrays of tables and inline tables. A statement this reader does not understand is skipped to the end of its line, and
the rest of the file is still read.
"""


class _Toml:
    def __init__(self, text):
        self.s = text
        self.i = 0
        self.root = {}
        self.at = self.root

    def ws(self, newlines=False):
        s = self.s
        while self.i < len(s):
            c = s[self.i]
            if c in " \t\r" or (newlines and c == "\n"):
                self.i += 1
            elif c == "#":
                while self.i < len(s) and s[self.i] != "\n":
                    self.i += 1
            else:
                break

    def skip_line(self):
        n = self.s.find("\n", self.i)
        self.i = len(self.s) if n < 0 else n + 1

    def key(self):
        parts = []
        while True:
            self.ws()
            if self.s[self.i:self.i + 1] in ('"', "'"):
                parts.append(self.string())
            else:
                m = re.compile(r"[A-Za-z0-9_-]+").match(self.s, self.i)
                if not m:
                    raise ValueError("key")
                parts.append(m.group(0))
                self.i = m.end()
            self.ws()
            if self.s[self.i:self.i + 1] == ".":
                self.i += 1
                continue
            return parts

    def string(self):
        s = self.s
        for q in ('"""', "'''"):
            if s.startswith(q, self.i):
                end = s.find(q, self.i + 3)
                if end < 0:
                    raise ValueError("string")
                body = s[self.i + 3:end]
                self.i = end + 3
                if body.startswith("\n"):
                    body = body[1:]
                return body if q == "'''" else self.unescape(body)
        q = s[self.i]
        end = self.i + 1
        while end < len(s) and s[end] != q and s[end] != "\n":
            end += 2 if q == '"' and s[end] == "\\" else 1
        if end >= len(s) or s[end] != q:
            raise ValueError("string")
        body = s[self.i + 1:end]
        self.i = end + 1
        return body if q == "'" else self.unescape(body)

    @staticmethod
    def unescape(body):
        try:
            return json.loads('"%s"' % body.replace("\n", "\\n").replace("\t", "\\t"))
        except ValueError:
            raise ValueError("escape")

    def value(self):
        self.ws()
        s, c = self.s, self.s[self.i:self.i + 1]
        if c in ('"', "'"):
            return self.string()
        if c == "[":
            self.i += 1
            out = []
            while True:
                self.ws(True)
                if s[self.i:self.i + 1] == "]":
                    self.i += 1
                    return out
                out.append(self.value())
                self.ws(True)
                if s[self.i:self.i + 1] == ",":
                    self.i += 1
        if c == "{":
            self.i += 1
            out = {}
            while True:
                self.ws()
                if s[self.i:self.i + 1] == "}":
                    self.i += 1
                    return out
                parts = self.key()
                if s[self.i:self.i + 1] != "=":
                    raise ValueError("inline")
                self.i += 1
                self.put(out, parts, self.value())
                self.ws()
                if s[self.i:self.i + 1] == ",":
                    self.i += 1
        m = re.compile(r"[^\s,\]\}#]+").match(s, self.i)
        if not m:
            raise ValueError("value")
        self.i = m.end()
        word = m.group(0)
        if word in ("true", "false"):
            return word == "true"
        if re.match(r"^[+-]?\d[\d_]*$", word):
            return int(word.replace("_", ""))
        return word

    @staticmethod
    def put(table, parts, value):
        for p in parts[:-1]:
            nxt = table.get(p)
            if not isinstance(nxt, dict):
                nxt = table[p] = {}
            table = nxt
        table[parts[-1]] = value

    def header(self):
        many = self.s.startswith("[[", self.i)
        self.i += 2 if many else 1
        parts = self.key()
        close = "]]" if many else "]"
        if not self.s.startswith(close, self.i):
            raise ValueError("header")
        self.i += len(close)
        table = self.root
        for p in parts[:-1]:
            nxt = table.get(p)
            if isinstance(nxt, list) and nxt and isinstance(nxt[-1], dict):
                nxt = nxt[-1]
            elif not isinstance(nxt, dict):
                nxt = table[p] = {}
            table = nxt
        last = parts[-1]
        if many:
            seq = table.get(last)
            if not isinstance(seq, list):
                seq = table[last] = []
            seq.append({})
            self.at = seq[-1]
        else:
            nxt = table.get(last)
            if not isinstance(nxt, dict):
                nxt = table[last] = {}
            self.at = nxt

    def parse(self):
        while True:
            self.ws(True)
            if self.i >= len(self.s):
                return self.root
            start = self.i
            try:
                if self.s[self.i] == "[":
                    self.header()
                else:
                    parts = self.key()
                    if self.s[self.i:self.i + 1] != "=":
                        raise ValueError("assignment")
                    self.i += 1
                    self.put(self.at, parts, self.value())
                self.ws()
                if self.i < len(self.s) and self.s[self.i] != "\n":
                    raise ValueError("trailing")
            except (ValueError, IndexError):
                self.i = start
                self.skip_line()


def read_toml(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return _Toml(fh.read()).parse()
    except (OSError, UnicodeDecodeError):
        return {}


def codex_config(home):
    return read_toml(os.path.join(home, "config.toml"))


def profiled(conf, key):
    """A top-level key, as the profile named by `profile` overrides it."""
    name = conf.get("profile")
    profiles = conf.get("profiles") if isinstance(conf.get("profiles"), dict) else {}
    prof = profiles.get(name) if isinstance(name, str) else None
    if isinstance(prof, dict) and key in prof:
        return prof[key]
    return conf.get(key)


"""Finding the skills, and the files whose stamps tell a turn that the index is out of date.

These are the folders Codex itself reads (codex-rs/ext/skills/src/host_roots.rs): the repository's .agents/skills and
.codex/skills from the working directory up to the repository's root, $CODEX_HOME/skills, ~/.agents/skills, the system
skills, /etc/codex/skills, and the skills of every plugin config.toml enables. Two more kinds of folder come from the
settings: extra folders (by default ~/.claude/skills, Claude Code's folder of personal skills),
and the plugins installed for Claude Code that are named in skillRouteClaudePlugins. Codex cannot read either kind
itself, but the injected path lets the model read the file.

Left out: a skill Codex has turned off in [[skills.config]], and one whose agents/openai.yaml sets
allow_implicit_invocation to false (meant to run only when named). When two skills share a name
(in any letter case) or a description, the one found first is kept, in the order above, so a skill Codex lists itself
wins over a copy kept elsewhere.
"""


def unquote_yaml(v):
    q = v[0]
    v = v[1:-1]
    if q == "'":
        return v.replace("''", "'")
    try:
        return json.loads('"%s"' % v.replace("\t", "\\t"))
    except ValueError:
        return v.replace('\\"', '"')


def frontmatter(path):
    """`name` and `description` and the rest of a SKILL.md's frontmatter as strings; {} when it has none and None when
    the file cannot be read. Only the first FRONTMATTER_BYTES are read."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read(FRONTMATTER_BYTES)
    except OSError:
        return None
    text = raw.decode("utf-8", "replace").lstrip(u"\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    m = re.match(r"^---[ \t]*\n(.*?)\n---[ \t]*(?:\n|$)", text, re.S)
    if not m:
        return {}
    lines, out, i = m.group(1).split("\n"), {}, 0
    while i < len(lines):
        km = re.match(r"^([A-Za-z_][\w-]*):[ \t]?(.*)$", lines[i])
        i += 1
        if not km:
            continue
        key, v = km.group(1), km.group(2).strip()
        if v in (">", "|", ">-", "|-", ">+", "|+", ""):
            buf = []
            while i < len(lines) and (lines[i][:1] in (" ", "\t") or lines[i].strip() == ""):
                buf.append(lines[i].strip())
                i += 1
            v = ("\n" if v.startswith("|") else " ").join(buf).strip()
        elif v[:1] in ('"', "'"):
            q = v[0]
            while not (len(v) > 1 and v.endswith(q) and not v.endswith("\\" + q)) and i < len(lines):
                v += " " + lines[i].strip()
                i += 1
            v = unquote_yaml(v) if len(v) > 1 and v.endswith(q) else v[1:]
        else:
            while i < len(lines) and lines[i][:1] in (" ", "\t") and lines[i].strip():
                v += " " + lines[i].strip()
                i += 1
        out[key] = v
    return out


def implicit_off(skill_dir):
    """Whether the skill's agents/openai.yaml sets policy.allow_implicit_invocation to false."""
    try:
        with open(os.path.join(skill_dir, "agents", "openai.yaml"), encoding="utf-8", errors="replace") as fh:
            text = fh.read(16 * 1024)
    except OSError:
        return False
    return bool(re.search(r"^policy:\s*$", text, re.M)) and bool(
        re.search(r"^[ \t]+allow_implicit_invocation:[ \t]*(false|False|no|off)[ \t]*(#.*)?$", text, re.M))


def repo_dirs(cwd, pathmod=os.path):
    """The skill folders of the repository `cwd` is in: each level from `cwd` up to the folder holding .git."""
    out = []
    if not isinstance(cwd, str) or not cwd or not pathmod.isabs(cwd):
        return out
    start = d = pathmod.normpath(cwd)
    while True:
        for sub in ((".agents", "skills"), (".codex", "skills")):
            p = pathmod.join(d, *sub)
            if pathmod.isdir(p):
                out.append(p)
        if pathmod.exists(pathmod.join(d, ".git")):
            return out
        up = pathmod.dirname(d)
        if up == d:
            # Not in a repository: Codex then reads the working directory's own folders only.
            return [p for p in out if pathmod.dirname(pathmod.dirname(p)) == start]
        d = up


def claude_home():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def plugin_roots(home, conf):
    """(plugin name, skills folder, folder of its versions) for every plugin config.toml enables, from Codex's plugin
    cache."""
    out = []
    plugins = conf.get("plugins") if isinstance(conf.get("plugins"), dict) else {}
    for ident, entry in sorted(plugins.items()):
        if not isinstance(entry, dict) or entry.get("enabled") is not True or "@" not in ident:
            continue
        name, market = ident.rsplit("@", 1)
        base = os.path.join(home, "plugins", "cache", market, name)
        try:
            versions = [os.path.join(base, v) for v in os.listdir(base)]
        except OSError:
            continue
        versions = [v for v in versions if os.path.isfile(os.path.join(v, ".codex-plugin", "plugin.json"))]
        if not versions:
            continue
        root = max(versions, key=lambda v: (os.stat(v).st_mtime, v))
        skills = "skills"
        try:
            with open(os.path.join(root, ".codex-plugin", "plugin.json"), encoding="utf-8") as fh:
                given = json.load(fh).get("skills")
            if isinstance(given, str) and given.strip():
                skills = given
        except (OSError, ValueError, AttributeError):
            pass
        out.append((name, os.path.normpath(os.path.join(root, skills)), base))
    return out


def claude_plugin_roots(wanted, codex_names):
    """(plugin name, skills folder) for the Claude Code plugins named in `wanted` ("*" for all) that Codex lacks."""
    if not wanted:
        return []
    try:
        with open(os.path.join(claude_home(), "plugins", "installed_plugins.json"), encoding="utf-8") as fh:
            installed = json.load(fh)
    except (OSError, ValueError):
        return []
    plugins = installed.get("plugins", installed) if isinstance(installed, dict) else {}
    out = []
    for key, entries in sorted(plugins.items()) if isinstance(plugins, dict) else []:
        name = key.split("@")[0]
        if name in codex_names or ("*" not in wanted and name not in wanted):
            continue
        paths = [e.get("installPath") for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []
        paths = [p for p in paths if isinstance(p, str) and os.path.isdir(p)]
        if paths:
            out.append((name, os.path.join(paths[0], "skills")))
    return out


def roots(home, cwd, conf, given, repos=()):
    """Every skill folder to read, as (kind, folder, plugin name or ''), in the order a duplicate is decided by."""
    out = [("repo", d, "") for d in list(repo_dirs(cwd)) + [r for r in repos if r]]
    out.append(("user", os.path.join(home, "skills"), ""))
    out.append(("user", os.path.join(os.path.expanduser("~"), ".agents", "skills"), ""))
    out.append(("system", os.path.join(home, "skills", ".system"), ""))
    out.append(("admin", os.path.join(os.sep, "etc", "codex", "skills"), ""))
    plugins = plugin_roots(home, conf)
    out += [("plugin", d, name) for name, d, _ in plugins]
    for d in given.get("skillRouteExtraDirs") or []:
        if isinstance(d, str) and d.strip():
            out.append(("extra", os.path.abspath(os.path.expanduser(d.strip())), ""))
    out += [("claude-plugin", d, name)
            for name, d in claude_plugin_roots(given.get("skillRouteClaudePlugins") or [], {p[0] for p in plugins})]
    seen, kept = set(), []
    for kind, d, name in out:
        if d not in seen:
            seen.add(d)
            kept.append((kind, d, name))
    return kept


def turned_off(conf):
    """The names and paths Codex's [[skills.config]] turns off."""
    names, paths = set(), set()
    skills = conf.get("skills") if isinstance(conf.get("skills"), dict) else {}
    entries = skills.get("config")
    for e in entries if isinstance(entries, list) else []:
        if isinstance(e, dict) and e.get("enabled") is False:
            if isinstance(e.get("name"), str):
                names.add(e["name"])
            if isinstance(e.get("path"), str):
                paths.add(os.path.normpath(os.path.expanduser(e["path"])))
    return names, paths


def stamp(path):
    """Modification time, size and inode. Two writes in the same second can leave the time unchanged, and an editor
    that saves by renaming a new file into place gives it a new inode."""
    try:
        st = os.stat(path)
        return [st.st_mtime_ns, st.st_size, st.st_ino]
    except OSError:
        return None


def folder_stamp(path):
    """A folder's stamp with the number of entries in it. On a file system whose times are coarse (a few milliseconds
    on some Linux file systems), adding a folder can leave its parent's time, size and inode all as they were."""
    st = stamp(path)
    if st is None:
        return None
    try:
        return st + [len(os.listdir(path))]
    except OSError:
        return st + [-1]


def one_line(text, limit=DESC_CHARS):
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    return t if len(t) <= limit else t[:limit - 3].rstrip() + "..."


def scan(home, cwd, given, repos=()):
    """The skills, and what was read to find them: {"skills": [...], "files": {path: stamp}, "dirs": {path: stamp}}."""
    conf_path = os.path.join(home, "config.toml")
    conf = read_toml(conf_path)
    off_names, off_paths = turned_off(conf)
    files, dirs = {conf_path: stamp(conf_path)}, {}
    cache = os.path.join(home, "plugins", "cache")
    try:
        markets = [os.path.join(cache, m) for m in os.listdir(cache)]
    except OSError:
        markets = []
    for d in [cache] + markets:
        dirs[d] = folder_stamp(d)
    for _, _, versions in plugin_roots(home, conf):
        dirs[versions] = folder_stamp(versions)
    installed = os.path.join(claude_home(), "plugins", "installed_plugins.json")
    if given.get("skillRouteClaudePlugins"):
        files[installed] = stamp(installed)
    skills, names, descs, visited = [], set(), set(), set()
    budget = [SCAN_MAX_DIRS]

    def visit(kind, d, plugin, depth):
        real = os.path.realpath(d)
        if budget[0] <= 0 or real in visited:
            return
        visited.add(real)
        budget[0] -= 1
        dirs[d] = folder_stamp(d)
        try:
            kids = sorted(os.listdir(d))
        except OSError:
            return
        for k in kids:
            sub = os.path.join(d, k)
            if k.startswith(".") or not os.path.isdir(sub):
                continue
            md = os.path.join(sub, "SKILL.md")
            if os.path.isfile(md):
                files[md] = stamp(md)
                dirs[sub] = stamp(sub)
                yaml = os.path.join(sub, "agents", "openai.yaml")
                if os.path.exists(yaml):
                    files[yaml] = stamp(yaml)
                add(kind, d, plugin, md, k)
            elif depth < SCAN_DEPTH:
                visit(kind, sub, plugin, depth + 1)

    def add(kind, root, plugin, md, folder):
        fm = frontmatter(md)
        if fm is None:
            return
        desc = one_line(fm.get("description"))
        short = one_line(fm.get("name"), 256) or folder
        name = "%s:%s" % (plugin, short) if plugin else short
        skill_dir = os.path.dirname(md)
        if name in off_names or os.path.normpath(md) in off_paths or os.path.normpath(skill_dir) in off_paths:
            return
        if implicit_off(skill_dir):
            return
        # A repository's skills are kept apart: they apply only in that repository, so they must not hide a skill of the
        # same name that applies everywhere.
        key = (root, name.casefold()) if kind == "repo" else name.casefold()
        if key in names or (kind != "repo" and desc and desc in descs):
            return
        names.add(key)
        if desc and kind != "repo":
            descs.add(desc)
        m = TRIGGER.search(desc)
        skills.append({"name": name, "short": short, "desc": desc, "path": os.path.realpath(md), "kind": kind,
                       "root": root, "triggers": m.group(1).strip() if m else ""})

    for kind, d, plugin in roots(home, cwd, conf, given, repos):
        if os.path.isdir(d):
            visit(kind, d, plugin, 1)
        else:
            dirs[d] = None
    return {"skills": skills, "files": files, "dirs": dirs, "conf": conf}


"""The keyword index.

The postings hold each skill's precomputed BM25 term weight, so a query only sums them:
the name, the words after its description's "Use when", and the description are weighted 4, 1 and 1, and a four-letter
piece of a word counts 0.6 of a whole word. The postings are kept as packed arrays rather than as tuples: a turn loads
the whole index, and fifty thousand small tuples took a quarter of the time a turn is allowed for its local work.
"""


def stem(w):
    """Strip a regular English plural ending (-s, -es, -ies)."""
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 4 and w.endswith(("ches", "shes", "sses", "xes", "zes")):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
        return w[:-1]
    return w


def tokens(text):
    t = CAMEL.sub(" ", text)
    t = (t + " " + text).lower() if t != text else text.lower()
    out = []
    for run in CJK.findall(t):
        out += ["c:" + run[i:i + 2] for i in range(len(run) - 1) if run[i:i + 2] not in CJK_STOP]
    for w in WORD.findall(CJK.sub(" ", t)):
        parts = [p for p in re.split(r"[-_.+/]", w) if p]
        for p in set(parts + [w]):
            if p in STOP or len(p) < 2:
                continue
            out.append("w:" + p)
            s = stem(p)
            if s != p:
                out.append("w:" + s)
            if len(p) > NGRAM + 1 and "/" not in p:
                out += ["g:" + p[i:i + NGRAM] for i in range(len(p) - NGRAM + 1)]
    return out


def keyword_index(skills):
    weighted = []
    for s in skills:
        tf, length = {}, 0.0
        for toks, w in ((tokens(s["name"].replace(":", " ") + " " + s["short"]), W_NAME),
                        (tokens(s["triggers"]), W_TRIGGER), (tokens(s["desc"]), W_DESC)):
            for x in toks:
                tf[x] = tf.get(x, 0.0) + w
            length += w * len(toks)
        weighted.append((tf, length))
    n = len(skills)
    avg = (sum(length for _, length in weighted) / n) if n else 1.0
    avg = avg or 1.0
    df = {}
    for tf, _ in weighted:
        for x in tf:
            df[x] = df.get(x, 0) + 1
    lists = {}
    for i, (tf, length) in enumerate(weighted):
        norm = K1 * (1 - B + B * length / avg)
        for x, f in tf.items():
            lists.setdefault(x, []).append((i, f * (K1 + 1) / (f + norm)))
    code = "H" if n < 65536 else "I"
    post = {x: (array.array(code, [i for i, _ in v]).tobytes(), array.array("f", [p for _, p in v]).tobytes())
            for x, v in lists.items()}
    idf = {x: math.log(1 + (n - c + 0.5) / (c + 0.5)) * (NGRAM_WEIGHT if x.startswith("g:") else 1.0)
           for x, c in df.items()}
    return {"post": post, "idf": idf, "code": code}


def keyword_scores(index, text):
    q = {}
    for x in tokens(text[:KEYWORD_CHARS]):
        q[x] = q.get(x, 0) + 1
    scores = {}
    kw = index["keyword"]
    post, idf = kw["post"], kw["idf"]
    for x, qf in q.items():
        hit = post.get(x)
        if not hit:
            continue
        ids, parts = array.array(kw["code"]), array.array("f")
        ids.frombytes(hit[0])
        parts.frombytes(hit[1])
        w = min(QUERY_TF_MAX, 1 + math.log(qf)) * idf[x]
        for i, part in zip(ids, parts):
            scores[i] = scores.get(i, 0.0) + w * part
    return {i: v for i, v in scores.items() if v > 0}


"""Bedrock request signing (Signature Version 4), credentials and region.

Everything is read the way Codex reads it for its model provider: the provider's `aws` table in config.toml, with its
credential_export command first, then its named profile, then the standard AWS environment variables, then the default
profile. A profile that signs in some other way (single sign-on, an assumed role) is not handled here, and the search
stays on keywords. Region order: the table's `region`, AWS_REGION, AWS_DEFAULT_REGION, the profile's region. A
request goes to AWS_ENDPOINT_URL_BEDROCK_RUNTIME or AWS_ENDPOINT_URL when either is set, as the AWS SDKs do, and through
HTTPS_PROXY when that is set (NO_PROXY is honoured), as urllib does by default.

Credentials must not reach a file or a log line; test_credentials_are_written_nowhere checks the data directory for them.
"""


class Unavailable(Exception):
    """The vector search cannot work with this configuration: it stays off for OFF_SECONDS, or until the provider,
    the region or the setting changes."""


class Transient(Exception):
    """Timeout, throttling or a server error: keywords for this turn only."""


def bedrock_provider(conf):
    """The `aws` table of Codex's model provider when that provider is Amazon Bedrock, else None. A provider is taken to
    be Bedrock when its id is Codex's built-in amazon-bedrock or when its own table has an `aws` table."""
    ident = profiled(conf, "model_provider")
    if not isinstance(ident, str) or not ident:
        return None
    providers = conf.get("model_providers") if isinstance(conf.get("model_providers"), dict) else {}
    own = providers.get(ident) if isinstance(providers.get(ident), dict) else {}
    aws = own.get("aws")
    if isinstance(aws, dict):
        return aws
    return {} if ident == "amazon-bedrock" else None


def aws_ini(env_key, default_name):
    p = configparser.RawConfigParser()
    try:
        p.read(os.environ.get(env_key) or os.path.join(os.path.expanduser("~"), ".aws", default_name), encoding="utf-8")
    except (configparser.Error, OSError, UnicodeDecodeError):
        pass
    return p


def profile_section(name):
    """(credentials file section, config file section) for a named AWS profile, each a dict."""
    creds, conf = aws_ini("AWS_SHARED_CREDENTIALS_FILE", "credentials"), aws_ini("AWS_CONFIG_FILE", "config")
    c = dict(creds.items(name)) if creds.has_section(name) else {}
    key = name if name == "default" else "profile " + name
    f = dict(conf.items(key)) if conf.has_section(key) else {}
    return c, f


def profile_name(aws):
    return aws["profile"] if isinstance(aws.get("profile"), str) and aws["profile"] else \
        os.environ.get("AWS_PROFILE") or "default"


def region_of(aws):
    for v in (aws.get("region"), os.environ.get("AWS_REGION"), os.environ.get("AWS_DEFAULT_REGION")):
        if isinstance(v, str) and v.strip():
            return v.strip()
    v = profile_section(profile_name(aws))[1].get("region")
    return v.strip() if isinstance(v, str) and v.strip() else ""


def kill_group(proc):
    try:
        if os.name == "nt":
            proc.kill()
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        pass


def run_credentials(argv, timeout):
    """Run a credential command and read the keys it prints. The command and everything it started are killed when it
    takes longer than `timeout`, and no more than CREDENTIAL_BYTES of what it prints is read."""
    flags = {"creationflags": 0x00000200} if os.name == "nt" else {"start_new_session": True}
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                close_fds=True, **flags)
    except OSError as e:
        raise Unavailable("the credential command could not be started (%s)" % type(e).__name__)
    got = []

    def read():
        try:
            got.append(proc.stdout.read(CREDENTIAL_BYTES + 1))
        except (OSError, ValueError):
            got.append(b"")

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    reader.join(max(0.05, timeout))
    if reader.is_alive():
        kill_group(proc)
        raise Transient("the credential command took longer than %.1f s" % timeout)
    out = got[0] if got else b""
    if len(out) > CREDENTIAL_BYTES:
        kill_group(proc)
        raise Unavailable("the credential command printed more than %d bytes" % CREDENTIAL_BYTES)
    try:
        code = proc.wait(max(0.05, timeout))
    except subprocess.TimeoutExpired:
        kill_group(proc)
        raise Transient("the credential command did not exit")
    finally:
        try:
            proc.stdout.close()
        except OSError:
            pass
    if code != 0:
        raise Unavailable("the credential command exited with %d" % code)
    text = out.decode("utf-8", "replace")
    try:
        found = json.loads(text)
        if not isinstance(found, dict):
            found = {}
    except ValueError:
        found = {}
        for line in text.splitlines():
            m = re.match(r"^\s*(?:export\s+)?(AWS_[A-Z_]+)=(.*)$", line)
            if m:
                found[m.group(1)] = m.group(2).strip().strip("'\"")
    key = found.get("AccessKeyId") or found.get("AWS_ACCESS_KEY_ID")
    secret = found.get("SecretAccessKey") or found.get("AWS_SECRET_ACCESS_KEY")
    if not isinstance(key, str) or not key or not isinstance(secret, str) or not secret:
        raise Unavailable("the credential command printed no access key that can be read")
    expires = found.get("Expiration")
    if isinstance(expires, str) and expires:
        try:
            when = datetime.datetime.strptime(expires[:19], "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            when = None
        if when is not None and when < datetime.datetime.utcnow():
            raise Transient("the credential command printed credentials that have expired")
    token = found.get("SessionToken") or found.get("AWS_SESSION_TOKEN") or ""
    return {"key": key, "secret": secret, "token": token if isinstance(token, str) else ""}


def from_profile(name, timeout):
    c, f = profile_section(name)
    for sec in (c, f):
        if sec.get("aws_access_key_id") and sec.get("aws_secret_access_key"):
            return {"key": sec["aws_access_key_id"], "secret": sec["aws_secret_access_key"],
                    "token": sec.get("aws_session_token", "")}
    if f.get("credential_process"):
        try:
            argv = shlex.split(f["credential_process"])
        except ValueError:
            raise Unavailable("the AWS profile %r has a credential_process that cannot be read" % name)
        return run_credentials(argv, timeout)
    if c or f:
        raise Unavailable("the AWS profile %r signs in a way this search does not handle" % name)
    return None


def credential_source(aws):
    """Where the credentials will come from: 'export', 'profile', 'environment' or 'default profile'."""
    export = aws.get("credential_export")
    if isinstance(export, dict) and isinstance(export.get("command"), str) and export["command"]:
        return "export"
    if isinstance(aws.get("profile"), str) and aws["profile"]:
        return "profile"
    if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
        return "environment"
    return "default profile"


def credentials(aws, timeout):
    source = credential_source(aws)
    if source == "export":
        export = aws["credential_export"]
        args = export.get("args") if isinstance(export.get("args"), list) else []
        return run_credentials([os.path.expanduser(export["command"])] + [str(a) for a in args], timeout)
    if source == "profile":
        got = from_profile(aws["profile"], timeout)
        if got:
            return got
        raise Unavailable("the AWS profile %r was not found" % aws["profile"])
    if source == "environment":
        return {"key": os.environ["AWS_ACCESS_KEY_ID"], "secret": os.environ["AWS_SECRET_ACCESS_KEY"],
                "token": os.environ.get("AWS_SESSION_TOKEN", "")}
    got = from_profile(os.environ.get("AWS_PROFILE") or "default", timeout)
    if got:
        return got
    raise Unavailable("no AWS credentials were found for the Bedrock provider")


def endpoint(region):
    """(scheme, host) to send to: an endpoint the AWS environment variables name, else the region's own."""
    given = os.environ.get("AWS_ENDPOINT_URL_BEDROCK_RUNTIME") or os.environ.get("AWS_ENDPOINT_URL") or ""
    if given:
        import urllib.parse
        u = urllib.parse.urlsplit(given)
        if u.scheme in ("http", "https") and u.netloc:
            return u.scheme, u.netloc
    return "https", "bedrock-runtime.%s.amazonaws.com%s" % (region, ".cn" if region.startswith("cn-") else "")


def sign(method, host, path, query, headers, body, creds, region, service, now=None):
    """Signature Version 4 headers for a request. `path` is as sent, already URI-encoded once; `query` a dict."""
    import urllib.parse
    now = now or datetime.datetime.utcnow()
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    hdrs = {k.lower(): re.sub(r"\s+", " ", str(v)).strip() for k, v in headers.items()}
    hdrs["host"] = host
    hdrs["x-amz-date"] = amz
    if creds.get("token"):
        hdrs["x-amz-security-token"] = creds["token"]
    # Every service but S3 signs the path URI-encoded once more than it is sent.
    canon_path = "/".join(urllib.parse.quote(seg, safe="-_.~") for seg in path.split("/")) or "/"
    canon_query = "&".join("%s=%s" % (urllib.parse.quote(str(k), safe="-_.~"), urllib.parse.quote(str(v), safe="-_.~"))
                           for k, v in sorted(query.items()))
    signed = ";".join(sorted(hdrs))
    canon = "\n".join([method, canon_path, canon_query, "".join("%s:%s\n" % (k, hdrs[k]) for k in sorted(hdrs)), signed,
                       hashlib.sha256(body).hexdigest()])
    scope = "%s/%s/%s/aws4_request" % (day, region, service)
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode("utf-8")).hexdigest()])
    k = ("AWS4" + creds["secret"]).encode("utf-8")
    for part in (day, region, service, "aws4_request"):
        k = hmac.new(k, part.encode("utf-8"), hashlib.sha256).digest()
    sig = hmac.new(k, to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    hdrs["authorization"] = "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s" % (
        creds["key"], scope, signed, sig)
    return hdrs


def embed_request(texts, input_type, model, region, creds):
    """(url, body, headers) of the request for `texts`: method POST."""
    import urllib.parse
    scheme, host = endpoint(region)
    path = "/model/%s/invoke" % urllib.parse.quote(model, safe="")
    body = json.dumps({"texts": texts, "input_type": input_type, "truncate": "END",
                       "embedding_types": ["float"]}).encode("utf-8")
    headers = sign("POST", host, path, {}, {"content-type": "application/json", "accept": "application/json"}, body,
                   creds, region, "bedrock")
    return "%s://%s%s" % (scheme, host, path), body, headers


def unit(v, dim=None):
    """`v` as a unit vector of floats, or None when it is not a vector of `dim` finite numbers that are not all zero."""
    if not isinstance(v, list) or not v or (dim and len(v) != dim):
        return None
    try:
        xs = [float(x) for x in v]
    except (TypeError, ValueError):
        return None
    norm = math.sqrt(sum(x * x for x in xs))
    if not math.isfinite(norm) or norm == 0:
        return None
    return array.array("f", [x / norm for x in xs])


def embed(texts, input_type, model, region, creds, timeout, dim=None):
    """Unit vectors for `texts` from Bedrock. Raises Unavailable or Transient."""
    import ssl
    import urllib.error
    import urllib.request
    url, body, headers = embed_request(texts, input_type, model, region, creds)
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        # build_opener() reads the proxy variables on every call; urlopen() keeps its first opener for the life of the
        # process, and the MCP server runs for hours.
        with urllib.request.build_opener().open(req, timeout=max(0.05, timeout)) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 429 or e.code >= 500:
            raise Transient("Bedrock answered %d" % e.code)
        raise Unavailable("Bedrock answered %d for %s" % (e.code, model))
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, ssl.SSLError):
            raise Unavailable("the TLS connection to Bedrock failed (%s)" % type(reason).__name__)
        if "timed out" in str(reason):
            raise Transient("Bedrock did not answer within %.1f s" % timeout)
        raise Transient("Bedrock could not be reached (%s)" % type(reason).__name__)
    except ssl.SSLError as e:
        raise Unavailable("the TLS connection to Bedrock failed (%s)" % type(e).__name__)
    except OSError as e:
        if "timed out" in str(e):
            raise Transient("Bedrock did not answer within %.1f s" % timeout)
        raise Transient("Bedrock could not be reached (%s)" % type(e).__name__)
    try:
        got = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise Transient("Bedrock's answer was not whole JSON")
    vecs = got.get("embeddings") if isinstance(got, dict) else None
    vecs = vecs.get("float") if isinstance(vecs, dict) else vecs
    if not isinstance(vecs, list) or len(vecs) != len(texts):
        raise Transient("Bedrock's answer held %s vectors for %d texts" %
                        (len(vecs) if isinstance(vecs, list) else "no", len(texts)))
    out = [unit(v, dim) for v in vecs]
    if any(v is None for v in out):
        if dim and any(isinstance(v, list) and v and len(v) != dim for v in vecs):
            raise Unavailable("Bedrock's vectors are no longer %d numbers long" % dim)
        raise Transient("Bedrock's answer held a vector that is empty, zero or not finite")
    return out


def model_candidates(region):
    """Model ids to try in `region`: the cross-region inference profile of the region's area (us., eu., apac.), the
    global profile, then the plain model id. The first that answers is kept in the index."""
    geo = {"us": "us.", "ca": "us.", "eu": "eu.", "ap": "apac."}.get(region.split("-")[0], "")
    if region.startswith("us-gov-"):
        geo = "us-gov."
    return [m for m in (geo + EMBED_MODEL if geo else "", "global." + EMBED_MODEL, EMBED_MODEL) if m]


"""Whether the vector search is off for now.

A lasting failure (no credentials that can be read, access denied, no such model in the region, a vector of the wrong
length, a TLS failure) is written down with what the configuration was, and the search stays off for OFF_SECONDS or
until the provider, the region, the credential source or the setting changes. Timeouts, throttling and server errors
are not recorded.
"""


def fingerprint(aws, given):
    return json.dumps([region_of(aws), credential_source(aws), aws.get("profile"),
                       json.dumps(aws.get("credential_export"), sort_keys=True), given.get("skillRouteVector")])


def vector_state(directory):
    try:
        with open(os.path.join(data_root(directory), VECTOR_STATE), encoding="utf-8") as fh:
            got = json.load(fh)
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def mark_unavailable(directory, why, print_):
    try:
        os.makedirs(data_root(directory), exist_ok=True)
        write_atomic(os.path.join(data_root(directory), VECTOR_STATE), json.dumps(
            {"offUntil": time.time() + OFF_SECONDS, "why": str(why)[:200], "config": print_}))
    except OSError:
        pass


def vector_off(directory, print_):
    """Why the vector search is off now for this configuration, or ''."""
    st = vector_state(directory)
    until = st.get("offUntil")
    if not isinstance(until, (int, float)) or until <= time.time() or st.get("config") != print_:
        return ""
    return str(st.get("why") or "it failed")


def vector_wanted(given, conf):
    """The `aws` table to search by meaning with, or None: only when the setting is on and the provider is Bedrock."""
    if given.get("skillRouteVector") is not True:
        return None
    return bedrock_provider(conf)


"""Rebuilding the index in a background process.

A turn that finds the index out of date starts `skill_route.py --build`, detached and with none of the hook's open
files, and carries on with the old one: Codex waits for a hook's output to close, so a rebuild holding the hook's pipe
would hold the turn. The build takes a lock folder so that two turns do not run two builds, writes the index to a
temporary file renamed into place, and keeps every skill's vector under a hash of the model id and the skill's text, so
a rebuild asks Bedrock only for skills whose name or description changed.
"""


def doc_text(skill):
    return ("%s: %s" % (skill["short"], skill["desc"]))[:DOC_CHARS]


def text_key(model, text):
    return hashlib.sha1((model + "\0" + text).encode("utf-8")).hexdigest()


def load_pickle(path):
    try:
        with open(path, "rb") as fh:
            return pickle.load(fh)
    except Exception:
        return None


def save_pickle(path, value):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with open(tmp, "wb") as fh:
            pickle.dump(value, fh, protocol=4)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def watched_settings(given):
    return json.dumps([given.get("skillRouteExtraDirs"), given.get("skillRouteClaudePlugins"),
                       given.get("skillRouteVector")], sort_keys=True)


def vectors_for(directory, skills, aws, given, region, old_model, deadline, sent=None):
    """(model, {i: vector}) for the skills, from the cache and then from Bedrock; partial when a request failed.
    `sent` collects how many texts each request carried."""
    cache_path = os.path.join(data_root(directory), EMBED_CACHE)
    cache = load_pickle(cache_path)
    cache = cache if isinstance(cache, dict) else {}
    print_ = fingerprint(aws, given)
    creds = None
    candidates = model_candidates(region)
    if old_model in candidates:
        candidates = [old_model] + [m for m in candidates if m != old_model]
    for model in candidates:
        got, missing = {}, []
        for i, s in enumerate(skills):
            v = cache.get(text_key(model, doc_text(s)))
            if isinstance(v, bytes) and v:
                got[i] = array.array("f")
                got[i].frombytes(v)
            else:
                missing.append(i)
        dims = {len(v) for v in got.values()}
        if len(dims) > 1:
            got, missing = {}, list(range(len(skills)))
        if not missing:
            return model, got
        dim = dims.pop() if len(dims) == 1 else None
        try:
            if creds is None:
                creds = credentials(aws, max(CREDENTIAL_TIMEOUT, 5.0))
            for start in range(0, len(missing), EMBED_BATCH):
                part = missing[start:start + EMBED_BATCH]
                for attempt in range(4):
                    left = deadline - time.time()
                    if left <= 1:
                        raise Transient("the rebuild ran out of time")
                    try:
                        if sent is not None:
                            sent.append(len(part))
                        vecs = embed([doc_text(skills[i]) for i in part], "search_document", model, region, creds,
                                     min(30.0, left), dim)
                        break
                    except Transient:
                        if attempt == 3:
                            raise
                        time.sleep(min(8.0, 1.5 * 2 ** attempt))
                    except Unavailable as e:
                        if dim and "no longer" in str(e):
                            # The model now answers with vectors of another length: the cached ones are dropped and
                            # the next rebuild embeds everything again.
                            save_pickle(cache_path, {})
                            raise Transient(str(e))
                        raise
                for i, v in zip(part, vecs):
                    got[i] = v
                    cache[text_key(model, doc_text(skills[i]))] = v.tobytes()
                    dim = dim or len(v)
            keep = {text_key(model, doc_text(s)) for s in skills}
            try:
                os.makedirs(data_root(directory), exist_ok=True)
                save_pickle(cache_path, {k: v for k, v in cache.items() if k in keep})
            except OSError:
                pass
            return model, got
        except Unavailable as e:
            if re.search(r"answered (400|404)", str(e)):
                continue
            mark_unavailable(directory, e, print_)
            return model, got
        except Transient:
            return model, got
    mark_unavailable(directory, "no id of %s is served in %s" % (EMBED_MODEL, region), print_)
    return "", {}


def build(directory, home, cwd, given=None, embed_now=True, deadline=None, write=True, sent=None):
    """Scan, index and (when `write`) save. Returns the index."""
    t0 = time.time()
    given = given or settings(directory)
    old = load_index(directory)
    repos = list(old.get("repos") or []) if old else []
    here = repo_dirs(cwd)
    repos = (here + [r for r in repos if r not in here])[:REPOS_KEPT]
    found = scan(home, cwd, given, repos)
    skills = found["skills"]
    index = {"version": INDEX_VERSION, "built": time.time(), "home": home, "repos": repos, "skills": skills,
             "files": found["files"], "dirs": found["dirs"], "settings": watched_settings(given),
             "keyword": keyword_index(skills), "model": "", "dim": 0, "vectors": b"", "has": [], "vectorTried": 0}
    aws = vector_wanted(given, found["conf"])
    if aws is not None and embed_now and not vector_off(directory, fingerprint(aws, given)):
        region = region_of(aws)
        index["vectorTried"] = time.time()
        if not region:
            mark_unavailable(directory, "no AWS region is set for the Bedrock provider", fingerprint(aws, given))
        else:
            model, got = vectors_for(directory, skills, aws, given, region, old.get("model") if old else "",
                                     deadline or time.time() + 90, sent)
            if got:
                dim = len(next(iter(got.values())))
                blob, has = array.array("f"), []
                for i in range(len(skills)):
                    v = got.get(i)
                    has.append(v is not None and len(v) == dim)
                    blob.extend(v if has[-1] else array.array("f", [0.0]) * dim)
                index.update(model=model, dim=dim, vectors=blob.tobytes(), has=has, region=region)
    if write:
        os.makedirs(data_root(directory), exist_ok=True)
        save_pickle(os.path.join(data_root(directory), INDEX_FILE), index)
        log(directory, {"ev": "build", "skills": len(skills), "vectors": sum(index["has"]), "ms":
                        round((time.time() - t0) * 1000, 1)})
    return index


def load_index(directory):
    got = load_pickle(os.path.join(data_root(directory), INDEX_FILE))
    return got if isinstance(got, dict) and got.get("version") == INDEX_VERSION else None


def stale(index, home, cwd, given, directory=None, conf=None):
    """Why `index` no longer describes what is installed, or ''. Stats files, and reads only the small file that says
    whether the vector search is off."""
    if index is None:
        return "no index"
    if index.get("home") != home:
        return "another Codex home"
    if index.get("settings") != watched_settings(given):
        return "settings changed"
    for p, st in index["files"].items():
        if stamp(p) != st:
            return "a file changed"
    for p, st in index["dirs"].items():
        if (folder_stamp(p) if st is not None and len(st) == 4 else stamp(p)) != st:
            return "a folder changed"
    if any(d not in index.get("repos", []) for d in repo_dirs(cwd)):
        return "a new repository"
    aws = vector_wanted(given, conf) if conf is not None else None
    if directory and aws is not None and not vector_off(directory, fingerprint(aws, given)):
        has = index.get("has") or []
        if (not index.get("dim") or not all(has)) and time.time() - (index.get("vectorTried") or 0) > RETRY_VECTORS:
            return "vectors missing"
    return ""


def writable(directory):
    root = data_root(directory)
    try:
        os.makedirs(root, exist_ok=True)
    except OSError:
        return False
    return os.access(root, os.W_OK)


def spawn_build(directory, cwd):
    """Start a rebuild that outlives this hook, unless one is already running or has just been started."""
    root = data_root(directory)
    try:
        os.makedirs(root, exist_ok=True)
        lock = os.path.join(root, BUILD_LOCK)
        if os.path.isdir(lock) and time.time() - os.stat(lock).st_mtime < BUILD_STALE:
            return False
        started = os.path.join(root, BUILT_AT)
        if os.path.exists(started) and time.time() - os.stat(started).st_mtime < BUILD_GAP:
            return False
        with open(started, "w") as fh:
            fh.write(str(time.time()))
        flags = {}
        if os.name == "nt":
            flags["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        else:
            flags["start_new_session"] = True
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "--build", directory, "--cwd", cwd or ""],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"), **flags)
        return True
    except OSError:
        return False


def build_locked(directory, home, cwd):
    root = data_root(directory)
    os.makedirs(root, exist_ok=True)
    lock = os.path.join(root, BUILD_LOCK)
    try:
        os.mkdir(lock)
    except FileExistsError:
        if time.time() - os.stat(lock).st_mtime < BUILD_STALE:
            return None
        try:
            os.rmdir(lock)
            os.mkdir(lock)
        except OSError:
            return None
    try:
        return build(directory, home, cwd, deadline=time.time() + BUILD_STALE - 10)
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass


"""Searching."""


def applies(skill, cwd_repos, mentioned):
    """False for a repository's skill outside that repository, for a skill named with $name (Codex already puts its
    whole SKILL.md in front of the model), and for a skill whose file was deleted."""
    if skill["kind"] == "repo" and skill["root"] not in cwd_repos:
        return False
    if skill["name"].casefold() in mentioned or skill["short"].casefold() in mentioned:
        return False
    return os.path.isfile(skill["path"])


def ranked(scores, skills):
    """Skill indexes by score, highest first, ties by name, so two runs give the same order."""
    return [i for i, _ in sorted(scores.items(), key=lambda kv: (-kv[1], skills[kv[0]]["name"]))]


def search(index, text, count, cwd, deadline, directory, given, conf, allow_vector=True):
    """(skills, how, timings, why it fell back): the top `count` skills for `text`, found by "vector" or "keyword"."""
    t0 = time.time()
    here = set(repo_dirs(cwd))
    mentioned = {m.casefold() for m in MENTION.findall(text)}
    skills = index["skills"]
    order = ranked(keyword_scores(index, text), skills)
    kept = []
    for i in order:
        if len(kept) >= count:
            break
        if applies(skills[i], here, mentioned):
            kept.append(i)
    timings = {"local": (time.time() - t0) * 1000, "net": 0.0}
    how, why = "keyword", ""
    aws = vector_wanted(given, conf) if allow_vector else None
    if aws is not None and index.get("dim") and index.get("model"):
        print_ = fingerprint(aws, given)
        why = vector_off(directory, print_)
        if not why:
            try:
                region = index.get("region") or region_of(aws)
                creds = credentials(aws, min(CREDENTIAL_TIMEOUT, deadline - time.time()))
                left = deadline - time.time()
                if left <= 0.05:
                    raise Transient("the time for this turn ran out before the request")
                tn = time.time()
                q = embed([text[:QUERY_CHARS]], "search_query", index["model"], region, creds, left, index["dim"])[0]
                timings["net"] = (time.time() - tn) * 1000
                tl = time.time()
                dim, has = index["dim"], index["has"]
                blob = array.array("f")
                blob.frombytes(index["vectors"])
                scores = {}
                for i in range(len(skills)):
                    if has[i]:
                        scores[i] = sum(map(operator.mul, q, blob[i * dim:(i + 1) * dim]))
                vec = [i for i in ranked(scores, skills) if applies(skills[i], here, mentioned)][:count]
                # A skill whose vector could not be had keeps the place its keywords give it.
                for pos, i in enumerate(kept):
                    if not has[i] and i not in vec:
                        vec.insert(min(pos, len(vec)), i)
                kept = vec[:count]
                timings["local"] += (time.time() - tl) * 1000
                how = "vector"
            except Unavailable as e:
                mark_unavailable(directory, e, print_)
                why = str(e)
            except Transient as e:
                why = str(e)
    return [skills[i] for i in kept], how, timings, why


def render(skills, intro=True, limit=CONTEXT_BYTES):
    """The block put in front of the model: one line per skill. When it would pass `limit` bytes, the longest
    descriptions are shortened until it fits."""
    head = ("%s, found by searching every installed skill for it (the skills list you were given is shortened and "
            "leaves some out). Judge whether one really fits before reading its SKILL.md; if none does, ignore this "
            "list." % MARK) if intro else ""
    descs = [one_line(s["desc"]) or "(no description)" for s in skills]

    def text():
        return "\n".join(([head] if head else []) + ["- %s: %s (file: %s)" % (s["name"], d, s["path"])
                                                     for s, d in zip(skills, descs)])

    out = text()
    while len(out.encode("utf-8")) > limit and descs:
        longest = max(range(len(descs)), key=lambda i: len(descs[i]))
        if len(descs[longest]) <= 40:
            break
        over = len(out.encode("utf-8")) - limit
        keep = max(37, len(descs[longest]) - max(20, over // 3 + 1))
        descs[longest] = descs[longest][:keep].rstrip() + "..."
        out = text()
    return out


def home_of(directory, pathmod=os.path):
    """The Codex home a data directory belongs to (<home>/plugins/data/<plugin>), else CODEX_HOME or ~/.codex."""
    parent = pathmod.dirname(pathmod.normpath(directory))
    if pathmod.basename(parent) == "data" and pathmod.basename(pathmod.dirname(parent)) == "plugins":
        return pathmod.dirname(pathmod.dirname(parent))
    return codex_home()


def search_text(directory, query, count, cwd, budget=BUDGET * 2):
    """What the MCP tool skill_search answers: the matching skills, one per line, or a sentence saying there are none."""
    t0 = time.time()
    given = settings(directory)
    home = home_of(directory)
    conf = codex_config(home)
    index = load_index(directory)
    if stale(index, home, cwd, given, directory, conf):
        if index is None or not writable(directory):
            index = build(directory, home, cwd, given, embed_now=False, write=False)
        spawn_build(directory, cwd)
    top, how, timings, why = search(index, query, count, cwd, t0 + budget, directory, given, conf)
    log(directory, {"ev": "search", "via": how, "skills": [s["name"] for s in top],
                    "ms": round((time.time() - t0) * 1000, 1)})
    if not top:
        return "No installed skill matches those words. Try other words for the same thing."
    return render(top, intro=False)


"""The log: which skills each turn was given and how they were found, which SKILL.md files it then read, and when the
index was rebuilt. It never holds what the user wrote. It is kept under LOG_MAX bytes by moving it aside once, so at
most twice that is on disk."""


def log(directory, record):
    path = os.path.join(data_root(directory), LOG_FILE)
    try:
        os.makedirs(data_root(directory), exist_ok=True)
        if os.path.exists(path) and os.path.getsize(path) > LOG_MAX:
            os.replace(path, path + ".1")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(dict({"t": round(time.time(), 3)}, **record), ensure_ascii=False) + "\n")
    except (OSError, ValueError):
        pass


SKILL_PATH = re.compile(r"""[^\s"'`<>|;&()]*SKILL\.md""")


def skills_read(tail, turn_id, index, cwd):
    """The skills whose SKILL.md this turn's tool calls named, and how many such files are not in the index.

    The rollout is read back from its end to the start of this turn, which is the line carrying its turn_id."""
    by_path, by_folder = {}, {}
    for s in (index or {}).get("skills") or []:
        p = os.path.realpath(s["path"])
        by_path[p] = s["name"]
        by_folder.setdefault(os.path.basename(os.path.dirname(p)), []).append(s["name"])
    named, unknown = [], 0
    if tail is None:
        return named, unknown
    for line in tail.lines():
        if turn_id and turn_id in line and ('"turn_context"' in line or '"task_started"' in line):
            break
        if "SKILL.md" not in line or ('"function_call"' not in line and '"custom_tool_call"' not in line):
            continue
        try:
            payload = json.loads(line).get("payload") or {}
        except (ValueError, AttributeError):
            continue
        args = payload.get("arguments") or payload.get("input") or ""
        args = args if isinstance(args, str) else json.dumps(args)
        try:
            inner = json.loads(args)
            args = " ".join(str(v) for v in (inner.values() if isinstance(inner, dict) else [inner]))
        except ValueError:
            pass
        for raw in SKILL_PATH.findall(args.replace("\\n", " ")):
            p = os.path.expanduser(raw)
            if not os.path.isabs(p) and cwd:
                p = os.path.join(cwd, p)
            name = by_path.get(os.path.realpath(p))
            if not name:
                # Either separator: a command run on Windows names the file with backslashes.
                parts = [x for x in re.split(r"[\\/]", p) if x]
                folder = by_folder.get(parts[-2], []) if len(parts) >= 2 else []
                name = folder[0] if len(folder) == 1 else None
            if name:
                if name not in named:
                    named.append(name)
            else:
                unknown += 1
    named.reverse()
    return named, unknown


def selftest():
    """Self-test that needs no other file. The full suite is test/route/test_skill_route.py in the extension's
    repository."""
    failures = []

    def check(cond, what):
        print(("ok    " if cond else "FAIL  ") + what)
        if not cond:
            failures.append(what)

    conf = _Toml('model_provider = "amazon-bedrock"\n[model_providers.amazon-bedrock.aws]\nregion = "x-1"\n').parse()
    check(bedrock_provider(conf) == {"region": "x-1"}, "config.toml is read")
    hdrs = sign("GET", "iam.amazonaws.com", "/", {"Action": "ListUsers", "Version": "2010-05-08"},
                {"content-type": "application/x-www-form-urlencoded; charset=utf-8"}, b"",
                {"key": "AKIDEXAMPLE", "secret": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"}, "us-east-1", "iam",
                now=datetime.datetime(2015, 8, 30, 12, 36, 0))
    check(hdrs["authorization"].endswith("Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"),
          "the signature matches AWS's worked example")
    idx = {"keyword": keyword_index([{"name": "a:cr-create", "short": "cr-create", "desc": "Publish a code review.",
                                      "triggers": ""}])}
    check(list(keyword_scores(idx, "publish my code reviews")) == [0], "the keyword search finds a skill")
    print("all checks pass" if not failures else "%d failed" % len(failures))
    return 0 if not failures else 1


def main(argv):
    if argv[1:2] == ["--selftest"]:
        return selftest()
    if argv[1:2] == ["--build"] and len(argv) >= 3:
        cwd = argv[argv.index("--cwd") + 1] if "--cwd" in argv and argv.index("--cwd") + 1 < len(argv) else ""
        try:
            build_locked(argv[2], home_of(argv[2]), cwd)
        except Exception as e:
            log(argv[2], {"ev": "error", "why": "build: %s: %s" % (type(e).__name__, str(e)[:160])})
            return 1
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
