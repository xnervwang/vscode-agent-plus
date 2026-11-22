#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""skill_route.py beside Claude Code's plan_agent.py, case by case, with a made-up Claude Code configuration.

    python3 test/route/claude_skill_route.py <claude hooks folder> <codex hooks folder> <scratch folder>

Each hooks folder holds the shared hooks with one agent's plan_agent.py, as the extensions ship them. Every case builds
its own home folder, Claude Code folder, project and plugin data folder under the scratch folder, with the AWS and
Claude Code variables taken out of the environment, and the managed settings folder pointed into the scratch folder,
so nothing here reads the machine's own configuration. A local HTTP server stands in for Bedrock. test/parts/90-shared-
skill-route.js runs it; each line it prints is one case.
"""
import array
import http.server
import json
import os
import subprocess
import sys
import threading
import time

CLAUDE_HOOKS, CODEX_HOOKS, SCRATCH = sys.argv[1], sys.argv[2], sys.argv[3]
for k in list(os.environ):
    if k.startswith("AWS_") or k.startswith("CLAUDE_") or k in ("CODEX_HOME", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"):
        del os.environ[k]
sys.dont_write_bytecode = True
sys.path.insert(0, CLAUDE_HOOKS)
import skill_route as route  # noqa: E402

failures = []
count = [0]


def check(cond, what):
    count[0] += 1
    print(("ok    " if cond else "FAIL  ") + what)
    if not cond:
        failures.append(what)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def skill(folder, name=None, desc=None, extra=""):
    lines = ["---"]
    if name:
        lines.append("name: %s" % name)
    if desc is not None:
        lines.append("description: %s" % desc)
    lines += ([extra] if extra else []) + ["---", "", "# Body of %s" % (name or os.path.basename(folder)), "", "Steps."]
    write(os.path.join(folder, "SKILL.md"), "\n".join(lines) + "\n")


n = [0]


def world():
    """A home folder with a Claude Code folder, a repository to work in and the plugins every case reads."""
    n[0] += 1
    root = os.path.join(SCRATCH, "w%d" % n[0])
    home = os.path.join(root, "home")
    claude = os.path.join(home, ".claude")
    repo = os.path.join(home, "work", "repo")
    cwd = os.path.join(repo, "sub")
    os.makedirs(os.path.join(repo, ".git"))
    os.makedirs(cwd)
    os.environ["HOME"] = os.environ["USERPROFILE"] = home
    os.environ["CLAUDE_CONFIG_DIR"] = claude
    managed = os.path.join(root, "managed")
    route.managed_root = lambda: managed

    skill(os.path.join(claude, "skills", "alpha"), "alpha", "Rotate the frobnicator keys every week.")
    skill(os.path.join(claude, "skills", "quiet"), "quiet", "Quiet hours for the pager.", "disable-model-invocation: true")
    skill(os.path.join(claude, "skills", "lazy"), "lazy", "Lint the gizmo files.", "paths:\n  - '*.gizmo'")
    skill(os.path.join(claude, "skills", "hidden"), "hidden", "Hidden by an override in user settings.")
    skill(os.path.join(claude, "skills", "typed"), "typed", "Only typed by the user, says the local settings.")
    skill(os.path.join(claude, "skills", "plain"), "plain")
    skill(os.path.join(repo, ".claude", "skills", "proj-one"), "proj-one", "Deploy the repository's widget service.")
    skill(os.path.join(cwd, ".claude", "skills", "proj-two"), "proj-two", "Seed the widget database for tests.")
    skill(os.path.join(home, "work", ".claude", "skills", "above"), "above", "A folder above the repository root.")
    skill(os.path.join(managed, ".claude", "skills", "corp"), "corp", "The organization's release checklist.")

    plugins = os.path.join(claude, "plugins")
    cache = os.path.join(plugins, "cache")

    def plugin(market, name, version, skills, manifest=None):
        base = os.path.join(cache, market, name, version)
        write(os.path.join(base, ".claude-plugin", "plugin.json"), json.dumps(dict({"name": name}, **(manifest or {}))))
        for folder, sname, sdesc in skills:
            skill(os.path.join(base, folder, sname), sname, sdesc)
        return base

    p_on = plugin("mk", "toolbox", "1.0", [("skills", "hammer", "Drive nails into the deck boards."),
                                          ("skills", "bare", None),
                                          ("extra", "level", "Check the shelf is level.")], {"skills": "./extra"})
    p_off = plugin("mk", "shelved", "1.0", [("skills", "saw", "Cut the planks to length.")])
    p_here = plugin("mk", "local-only", "1.0", [("skills", "drill", "Drill pilot holes in the frame.")])
    p_there = plugin("mk", "elsewhere", "1.0", [("skills", "sand", "Sand the tabletop smooth.")])
    p_stale = plugin("dirmk", "live", "0.9", [("skills", "old", "The cached copy's skill.")])
    market = os.path.join(root, "market")
    write(os.path.join(market, ".claude-plugin", "marketplace.json"),
          json.dumps({"name": "dirmk", "plugins": [{"name": "live", "source": "./live"}]}))
    write(os.path.join(market, "live", ".claude-plugin", "plugin.json"), json.dumps({"name": "live"}))
    skill(os.path.join(market, "live", "skills", "fresh"), "fresh", "Paint the fence with the new colour.")
    write(os.path.join(plugins, "known_marketplaces.json"), json.dumps({
        "dirmk": {"source": {"source": "directory", "path": market}, "installLocation": market},
        "mk": {"source": {"source": "github", "repo": "someone/mk"}, "installLocation": os.path.join(plugins, "m")}}))
    write(os.path.join(plugins, "installed_plugins.json"), json.dumps({"version": 2, "plugins": {
        "toolbox@mk": [{"scope": "user", "installPath": p_on}],
        "shelved@mk": [{"scope": "user", "installPath": p_off}],
        "local-only@mk": [{"scope": "project", "projectPath": repo, "installPath": p_here}],
        "elsewhere@mk": [{"scope": "project", "projectPath": os.path.join(home, "other"), "installPath": p_there}],
        "live@dirmk": [{"scope": "user", "installPath": p_stale}]}}))
    write(os.path.join(claude, "settings.json"), json.dumps({
        "enabledPlugins": {"toolbox@mk": True, "shelved@mk": False, "missing@mk": True, "local-only@mk": True,
                           "elsewhere@mk": True, "live@dirmk": True},
        "skillOverrides": {"hidden": "off", "toolbox:hammer": "off", "alpha": "name-only"}}))
    write(os.path.join(cwd, ".claude", "settings.local.json"), json.dumps({"skillOverrides": {"typed": "user-invocable-only"}}))
    data = os.path.join(root, "data", "agent-work-plan-claude-code-extras")
    os.makedirs(data)
    return {"root": root, "home": home, "claude": claude, "repo": repo, "cwd": cwd, "data": data, "managed": managed}


"""What is found, by which name, and what is left out."""
w = world()
found = route.claude_scan(w["claude"], w["cwd"])
names = sorted(s["name"] for s in found["skills"])
by = {s["name"]: s for s in found["skills"]}
check(names == sorted(["alpha", "plain", "proj-one", "proj-two", "corp", "toolbox:hammer", "toolbox:level", "local-only:drill",
                       "live:fresh"]), "the skills Claude Code offers here are found, and no others: %s" % names)
check("alpha" in by and "corp" in by and by["alpha"]["kind"] == "user" and by["corp"]["kind"] == "managed",
      "personal skills and the managed folder's skills are found")
check(by.get("proj-one", {}).get("kind") == "project" and "proj-two" in by and "above" not in by,
      "project skills come from the working folder up to the repository root, not above it")
check("toolbox:hammer" in by and "toolbox:level" in by,
      "an enabled, installed plugin's skills are named <plugin>:<skill>, from skills/ and the folder plugin.json adds")
check(not any(x.startswith("shelved:") for x in names), "an installed plugin that is turned off gives nothing")
check(not any(x.startswith("missing:") for x in names), "a plugin that is enabled but not installed gives nothing")
check("local-only:drill" in by and not any(x.startswith("elsewhere:") for x in names),
      "a plugin installed for this project is found, one installed for another project is not")
check("live:fresh" in by and "live:old" not in by,
      "a plugin of a marketplace kept in a local folder is read from that folder, not from the cache")
check("quiet" not in by, "disable-model-invocation: true leaves a skill out")
check("lazy" not in by, "a skill with paths, offered only once a matching file is touched, is left out")
check("hidden" not in by and "typed" not in by,
      "skillOverrides off in the user settings and user-invocable-only in the local settings leave a skill out")
check("alpha" in by and "toolbox:hammer" in by, "name-only keeps a skill, and skillOverrides do not reach plugin skills")
check(by.get("plain", {}).get("desc") == "Body of plain" and "toolbox:bare" not in by,
      "a personal skill with no description is described by its body's first line; a plugin's is left out")

skill(os.path.join(w["claude"], "skills", "folder-name"), "shown-name", "A skill whose name differs from its folder.")
skill(os.path.join(w["claude"], "plugins", "cache", "mk", "toolbox", "1.0", "skills", "box-folder"), "box-shown",
      "A plugin skill whose name differs from its folder.")
again = {s["name"]: s for s in route.claude_scan(w["claude"], w["cwd"])["skills"]}
check("folder-name" in again and "shown-name" not in again and "toolbox:box-folder" in again and "toolbox:box-shown" not in again,
      "a skill is called by its folder's name, a plugin's as <plugin>:<folder>, whatever its frontmatter name says")
old = json.load(open(os.path.join(w["claude"], "settings.json")))
write(os.path.join(w["claude"], "settings.json"), json.dumps(dict(old, skillOverrides=dict(old["skillOverrides"], **{"shown-name": "off"}))))
check("folder-name" not in {s["name"] for s in route.claude_scan(w["claude"], w["cwd"])["skills"]},
      "skillOverrides by a skill's frontmatter name leaves it out too")

link = os.path.join(w["root"], "home-link")
os.symlink(w["home"], link)
os.environ["HOME"] = link
walked = route.claude_project_dirs(w["cwd"])
os.environ["HOME"] = w["home"]
check(route.claude_project_dirs(os.path.join(w["home"], "loose")) == [os.path.join(w["home"], "loose", ".claude", "skills")]
      and os.path.join(w["home"], ".claude", "skills") not in route.claude_project_dirs(os.path.join(w["home"], "work", "x"))
      and walked == route.claude_project_dirs(w["cwd"]),
      "outside a repository the walk stops below the home folder; inside one, at the repository's root")
os.makedirs(os.path.join(w["home"], "loose2"))
os.environ["HOME"] = link
past = route.claude_project_dirs(os.path.join(w["home"], "loose2"))
os.environ["HOME"] = w["home"]
check(os.path.join(w["home"], ".claude", "skills") in past and past[-1] == os.path.join(os.path.abspath(os.sep), ".claude", "skills"),
      "with HOME a link to the home folder the walk does not know it and goes on to the root, as Claude Code's does")

"""The block and the turn."""
block = route.render([by["toolbox:hammer"], by["alpha"]])
lines = block.split("\n")
check(lines[0].startswith(route.MARK) and "Skill tool" in lines[0] and lines[1:] == [
    "- toolbox:hammer: Drive nails into the deck boards.", "- alpha: Rotate the frobnicator keys every week."],
    "the block names each skill as the Skill tool takes it, with its whole description and no file")
long_desc = "word " * 700
check(route.one_line(long_desc, route.CLAUDE_DESC_CHARS) in route.render([dict(by["alpha"], desc=long_desc)]),
      "a description of 3,500 characters is given whole")

TRANSCRIPT = os.path.join(w["root"], "t.jsonl")
SESSION = "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6"


def payload(prompt, cwd=None):
    return {"hook_event_name": "UserPromptSubmit", "session_id": SESSION, "transcript_path": TRANSCRIPT,
            "cwd": cwd or w["cwd"], "prompt": prompt}


def attach(text):
    with open(TRANSCRIPT, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "attachment", "attachment": {"type": "hook_additional_context", "content": [text],
                                                                    "hookEvent": "UserPromptSubmit"}}) + "\n")


def row(obj):
    with open(TRANSCRIPT, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj) + "\n")


given = route.settings(w["data"])
check(given.get("skillRoute") is True and given.get("skillRouteVector") is False and given.get("skillRouteCount") == 5,
      "the settings default to on, by keywords, five skills")
route.build(w["data"], w["claude"], w["cwd"], given)
row({"type": "user", "message": {"content": "hello"}})
first = route.claude_submit(payload("rotate the frobnicator keys and drive the deck nails"), w["data"], given, time.time())
check(first is not None and "- alpha: Rotate the frobnicator keys every week." in first and
      "- toolbox:hammer: Drive nails into the deck boards." in first, "a matching message is given both skills in full")
attach(first)
second = route.claude_submit(payload("rotate the frobnicator keys and drive the deck nails again"), w["data"], given, time.time())
check(second is not None and route.ORDER_LINE in second and "alpha (given earlier)" in second and
      "- alpha:" not in second and "- toolbox:hammer:" not in second,
      "skills given earlier in the conversation are named in order of fit, not repeated in full")
routed = open(route.side_file(route.plan_file(payload("x"), w["data"]), route.ROUTED_SUFFIX), encoding="utf-8").read()
check("frobnicator keys and drive" not in routed and "alpha" in routed,
      "the record of what was given holds skill names and descriptions, never what the user wrote")
skill(os.path.join(w["claude"], "skills", "alpha"), "alpha", "Rotate the frobnicator keys every day now.")
route.build(w["data"], w["claude"], w["cwd"], given)
third = route.claude_submit(payload("rotate the frobnicator keys and drive the deck nails"), w["data"], given, time.time())
check(third is not None and "- alpha: Rotate the frobnicator keys every day now." in third,
      "a skill whose description changed is given in full again")
attach(third)
row({"type": "system", "subtype": "compact_boundary"})
fourth = route.claude_submit(payload("rotate the frobnicator keys and drive the deck nails"), w["data"], given, time.time())
check(fourth is not None and route.ORDER_LINE not in fourth and "- alpha:" in fourth and "- toolbox:hammer:" in fourth,
      "after a compaction every skill is given in full again")
slashed = route.claude_submit(payload("/alpha rotate the frobnicator keys"), w["data"], given, time.time())
check(slashed is None or ("- alpha:" not in slashed and "alpha (given earlier)" not in slashed),
      "a skill run with /name is not offered in the same turn")
check(route.claude_submit(payload("ok"), w["data"], given, time.time()) is None, "a message under six characters gets nothing")

"""The index, one per folder, and the time a turn takes."""
other = os.path.join(w["home"], "elsewhere")
os.makedirs(other)
index = route.load_index(w["data"], w["cwd"])
check(index is not None and route.load_index(w["data"], other) is None and index["cwd"] == w["cwd"],
      "each folder a conversation starts in has an index of its own")
stood = route.claude_submit(payload("drive the deck nails", cwd=other), w["data"], given, time.time())
log = [json.loads(x) for x in open(os.path.join(route.data_root(w["data"]), route.LOG_FILE), encoding="utf-8")]
check(stood is not None and "toolbox:hammer" in stood and "proj-one" not in stood and log[-1].get("standIn") is True,
      "a folder with no index yet is searched with another folder's, without that folder's project skills")
deadline = time.time() + 30
while time.time() < deadline and route.load_index(w["data"], other) is None:
    time.sleep(0.05)
check(route.load_index(w["data"], other) is not None, "the folder's own index is built in the background")
check(route.stale(route.load_index(w["data"], w["cwd"]), w["claude"], w["cwd"], given, w["data"],
                  route.claude_conf(w["claude"], w["cwd"])) == "", "an index is current right after it is built")
write(os.path.join(w["claude"], "settings.json"), json.dumps({"enabledPlugins": {"toolbox@mk": False}}))
check(route.stale(route.load_index(w["data"], w["cwd"]), w["claude"], w["cwd"], given, w["data"],
                  route.claude_conf(w["claude"], w["cwd"])) == "a file changed", "a change to the settings makes it stale")
skill(os.path.join(w["repo"], ".claude", "skills", "proj-three"), "proj-three", "A new project skill.")
check(route.stale(route.load_index(w["data"], w["cwd"]), w["claude"], w["cwd"], given, w["data"],
                  route.claude_conf(w["claude"], w["cwd"])) != "", "a new project skill makes it stale")

"""The hook as Claude Code runs it."""
HOOK = os.path.join(SCRATCH, "route-skills.py")
write(HOOK, "\n".join([
    "import time", "T0 = time.time()", "import sys", "sys.dont_write_bytecode = True",
    "sys.path.insert(0, %r)" % CLAUDE_HOOKS, "import skill_route",
    "skill_route.managed_root = lambda: %r" % w["managed"], "sys.exit(skill_route.run_hook(T0))", ""]))


def hook(event, prompt, config=None):
    if config is not None:
        write(os.path.join(w["data"], "config.json"), json.dumps(config))
    body = json.dumps(dict(payload(prompt), hook_event_name=event))
    r = subprocess.run([sys.executable, "-B", HOOK, w["data"]], input=body.encode(), stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, env=dict(os.environ), timeout=60)
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


write(os.path.join(w["claude"], "settings.json"), json.dumps({"enabledPlugins": {"toolbox@mk": True}}))
deadline = time.time() + 30
while time.time() < deadline:
    route.build(w["data"], w["claude"], w["cwd"], given)
    if route.stale(route.load_index(w["data"], w["cwd"]), w["claude"], w["cwd"], given, w["data"],
                   route.claude_conf(w["claude"], w["cwd"])) == "":
        break
code, out, err = hook("UserPromptSubmit", "drive the deck nails")
try:
    shown = json.loads(out)["hookSpecificOutput"]
except ValueError:
    shown = {}
check(code == 0 and shown.get("hookEventName") == "UserPromptSubmit" and
      "- toolbox:hammer: Drive nails into the deck boards." in shown.get("additionalContext", ""),
      "the hook prints the block as Claude Code's additionalContext (%s)" % (err.strip()[-200:] or "no error"))
code, out, _ = hook("UserPromptSubmit", "drive the deck nails", {"skillRoute": False})
check(code == 0 and out.strip() == "", "with skillRoute off in the extension's settings the hook prints nothing")
write(os.path.join(w["data"], "config.json"), "{}")
with open(TRANSCRIPT, "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"type": "user", "message": {"content": "drive the deck nails"}}) + "\n")
    fh.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Skill", "input": {"skill": "toolbox:hammer"}}]}}) + "\n")
hook("Stop", "")
last = [json.loads(x) for x in open(os.path.join(route.data_root(w["data"]), route.LOG_FILE), encoding="utf-8")][-1]
check(last.get("ev") == "read" and last.get("skills") == ["toolbox:hammer"],
      "at the end of a turn the log records the skills its Skill tool calls named")

"""Searching by meaning, through a stand-in for Bedrock."""
KEY, SECRET, TOKEN = "AKIDTESTONLYCLAUDE01", "secretTESTONLYclaude/0000+abcdefghij", "tokenTESTONLYclaude-0000"
DIM = 4
seen = []


def vec(text):
    t = text.lower()
    return [1.0 if "nail" in t else 0.0, 1.0 if "level" in t else 0.0, 1.0 if "fence" in t else 0.0, 0.1]


class Bedrock(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        seen.append((self.path, self.headers.get("authorization", ""), body["input_type"], len(body["texts"]),
                     self.headers.get("x-amz-security-token", "")))
        out = json.dumps({"embeddings": {"float": [vec(x) for x in body["texts"]]}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Bedrock)
threading.Thread(target=server.serve_forever, daemon=True).start()
export = os.path.join(w["root"], "export-creds.py")
write(export, "import json\nprint(json.dumps({'Credentials': {'AccessKeyId': %r, 'SecretAccessKey': %r, "
              "'SessionToken': %r}}))\n" % (KEY, SECRET, TOKEN))
write(os.path.join(w["claude"], "settings.json"), json.dumps({
    "enabledPlugins": {"toolbox@mk": True}, "awsCredentialExport": "%s %s" % (sys.executable, export),
    "env": {"CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": "us-west-2"}}))
os.environ["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = "http://127.0.0.1:%d" % server.server_address[1]
conf = route.claude_conf(w["claude"], w["cwd"])
aws = route.claude_bedrock(conf)
check(aws is not None and aws.get("region") == "us-west-2" and aws.get("credential_export", {}).get("args", [])[-1:] ==
      [conf["credentialExport"]], "Claude Code on Bedrock gives the search its region and its awsCredentialExport")
check(route.claude_bedrock(route.claude_conf(w["claude"], w["cwd"])) is not None and
      route.vector_wanted(given, conf) is None, "the search stays on keywords unless skillRouteVector is on")
vgiven = dict(given, skillRouteVector=True)
route.build(w["data"], w["claude"], w["cwd"], vgiven)
vindex = route.load_index(w["data"], w["cwd"])
check(vindex is not None and vindex.get("dim") == DIM and all(vindex.get("has") or [False]),
      "the index holds a vector for every skill, from credentials printed as STS prints them")
top, how, _, why = route.search(vindex, "is my shelf level", 2, w["cwd"], time.time() + 5, w["data"], vgiven, conf)
check(how == "vector" and top and top[0]["name"] == "toolbox:level", "the search goes by meaning (%s)" % (why or how))
check(seen and all(("Credential=%s/" % KEY) in a for _, a, _, _, _ in seen), "each request is signed with those credentials")
check(seen and all(tok == TOKEN and "/us-west-2/bedrock/aws4_request" in a and "x-amz-security-token" in
                   a.split("SignedHeaders=")[1].split(",")[0].split(";") and p.startswith("/model/us.cohere.embed-v4") for
                   p, a, _, _, tok in seen),
      "and carries the session token, signed with it, for Claude Code's region and the region's cross-region model id")
leaked = []
for base, _, fs in os.walk(w["data"]):
    for f in fs:
        with open(os.path.join(base, f), "rb") as fh:
            blob = fh.read()
        leaked += [f for s in (KEY, SECRET, TOKEN) if s.encode() in blob]
check(not leaked, "no credential is written to the data folder")
write(os.path.join(w["claude"], "settings.json"), json.dumps({"enabledPlugins": {"toolbox@mk": True}}))
check(route.vector_wanted(vgiven, route.claude_conf(w["claude"], w["cwd"])) is None,
      "without CLAUDE_CODE_USE_BEDROCK the search stays on keywords")
del os.environ["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"]
server.shutdown()

"""Codex's side keeps its shape."""
probe = subprocess.run([sys.executable, "-B", "-c", """
import json, os, sys, tempfile
sys.path.insert(0, sys.argv[1])
import skill_route as r
home = tempfile.mkdtemp(dir=sys.argv[2])
os.makedirs(os.path.join(home, "skills", "hammer"))
open(os.path.join(home, "skills", "hammer", "SKILL.md"), "w").write("---\\nname: hammer\\ndescription: Drive nails.\\n---\\n")
data = os.path.join(home, "plugins", "data", "agent-work-plan-codex-extras")
os.makedirs(data)
os.environ["CODEX_HOME"] = home
idx = r.build(data, home, "", {})
print(json.dumps([r.CLAUDE, os.listdir(r.data_root(data)), r.render(idx["skills"]).split("\\n")[1], r.home_of("/nowhere"),
                  home]))
""", CODEX_HOOKS, SCRATCH], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, HOME=w["home"]))
try:
    got = json.loads(probe.stdout)
except ValueError:
    got = [None, [], probe.stderr.decode()[-200:], None, ""]
check(got[0] is False and "index.pickle" in got[1] and got[2].startswith("- hammer: Drive nails. (file: ")
      and got[3] == got[4], "beside Codex's plan_agent.py the module keeps Codex's index file, its block with files, and "
      "Codex's home (%s)" % got[2])

print("%d checks, %d failed" % (count[0], len(failures)))
sys.exit(1 if failures else 0)
