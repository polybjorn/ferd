"""The client's JSDoc typedefs, read so a test can hold API responses to them.

The frontend types each JSON body it reads with a `@typedef` (the pattern is
`AuthState` in app/core.js), and the Python handlers build those bodies
separately. `ENDPOINTS` names, for each endpoint the client reads as JSON, the
typedef that describes it; `check` compares a decoded body against one. Every
response key has to be declared, every required property present, and each
value of the declared type, so a key added, renamed or retyped on one side
fails until the other side follows.

The parser covers the type syntax the typedefs use: `string`, `number`,
`boolean`, `null`, `object`, string literals, `T[]`, `Array<T>`,
`Object<string, T>`, `Record<string, T>`, `{ a: T, b?: T }`, unions,
intersections and `import('./file.js').Name`. `any`, `unknown` and anything
it does not know (a function type, a generic) pass unchecked.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# (method, path, file, typedef, where). `where` is None when the typedef is the
# whole body, or `key[]` when the body is an object whose `key` holds a list of
# that typedef. A path starting `/u/` is read signed out from the public map.
ENDPOINTS = [
  ("GET", "/health", "app/main.js", "HealthData", None),
  ("GET", "/state", "app/core.js", "AuthState", None),
  ("GET", "/public-maps", "app/sign-in.js", "PublicMaps", None),
  ("POST", "/login", "app/sign-in.js", "SignInResult", None),
  ("POST", "/register", "app/sign-in.js", "SignInResult", None),
  ("GET", "/sessions", "app/settings/account.js", "SessionData", "sessions[]"),
  ("GET", "/me/tokens", "app/settings/account.js", "TokenData", "tokens[]"),
  ("POST", "/me/tokens", "app/settings/settings.js", "NewToken", None),
  ("POST", "/me/import", "app/settings/settings.js", "ImportResponse", None),
  ("GET", "/catalog", "app/places-list.js", "CatalogEntry[]", None),
  ("GET", "/catalog?include_hidden=1", "app/settings/catalog.js", "AdminCatalogEntry[]", None),
  ("POST", "/admin/catalog/add", "app/settings/catalog.js", "CatalogAddResult", None),
  ("GET", "/admin/stats", "app/settings/account.js", "AdminStats", None),
  ("GET", "/admin/users", "app/settings/account.js", "AdminUserData", "users[]"),
  ("GET", "/admin/logs", "app/settings/logs.js", "LogPage", None),
  ("GET", "/sync/changes", "app/store.js", "SyncPage", None),
  ("POST", "/sync/batch", "app/store.js", "SyncBatchResult", None),
  ("GET", "/u/<name>/places", "app/core.js", "Place[]", None),
  ("GET", "/u/<name>/areas", "app/core.js", "Area[]", None),
  ("GET", "/u/<name>/routes", "app/core.js", "Manifest", None),
  ("GET", "/u/<name>/category-labels", "app/core.js", "CategoryLabelsBody", None),
]

# Literal `api('METHOD', '/path'...)` calls in app/ whose response the client
# does not read. Every other literal call has to be a row in ENDPOINTS.
NOT_READ = {
  ("POST", "/logout"),
  ("POST", "/change-password"),
  ("POST", "/sessions/revoke"),
  ("POST", "/sessions/revoke-others"),
  ("POST", "/me/tokens/revoke"),
  ("POST", "/me/publish"),
  ("POST", "/admin/users/"),
  ("DELETE", "/admin/users/"),
  ("DELETE", "/admin/logs"),
  ("POST", "/admin/catalog/hide"),
  ("POST", "/admin/catalog/delete"),
  ("POST", "/admin/catalog/clear"),
  ("POST", "/settings/registration"),
  ("POST", "/admin/settings/publishing"),
  ("POST", "/admin/settings/catalog-baseline"),
  ("POST", "/admin/unpublish-all"),
  ("DELETE", "/gpx"),
  ("POST", "/gpx/set-completed"),
  ("POST", "/gpx/move"),
  ("POST", "/regions/rename"),
  ("POST", "/regions/delete"),
  ("POST", "/regions/clear"),
}

_API_CALL = re.compile(r"""\bapi\(\s*'([A-Z]+)'\s*,\s*'([^'?]*)""")


def literal_api_calls() -> set[tuple[str, str]]:
  """Every `api('METHOD', '/literal...')` in app/, as (method, literal path)."""
  out = set()
  for f in sorted((REPO_ROOT / "app").rglob("*.js")):
    for m in _API_CALL.finditer(f.read_text(encoding="utf-8")):
      out.add((m.group(1), m.group(2)))
  return out


# ---------- typedef extraction ----------

_COMMENT = re.compile(r"/\*\*(.*?)\*/", re.S)


def _balanced(text: str, start: int) -> int:
  """Index just past the `}` matching the `{` at `start`."""
  depth = 0
  for i in range(start, len(text)):
    if text[i] == "{":
      depth += 1
    elif text[i] == "}":
      depth -= 1
      if depth == 0:
        return i + 1
  raise ValueError(f"unbalanced braces in {text[start:start + 60]!r}")


def _tags(comment: str):
  """(tag, type, rest) for each `@tag {type} rest` in one doc comment."""
  body = "\n".join(re.sub(r"^\s*\*\s?", "", ln) for ln in comment.splitlines())
  for m in re.finditer(r"@(typedef|property|prop)\s*", body):
    i = m.end()
    if i >= len(body) or body[i] != "{":
      continue
    end = _balanced(body, i)
    rest = body[end:].split("\n", 1)[0].split("@", 1)[0]
    yield m.group(1), body[i + 1:end - 1].strip(), rest.strip()


def typedefs_in(path: Path) -> dict[str, object]:
  """The typedefs a file declares, by name, each as a parsed type."""
  out: dict[str, object] = {}
  for cm in _COMMENT.finditer(path.read_text(encoding="utf-8")):
    props: dict[str, tuple[object, bool]] | None = None
    for tag, typ, rest in _tags(cm.group(1)):
      if tag == "typedef":
        words = rest.split()
        props = None
        if not words:
          continue
        if typ in ("object", "Object"):
          props = {}
          out[words[0]] = ("obj", props)
        else:
          out[words[0]] = _Parser(typ).parse()
      elif props is not None:
        m = re.match(r"(\[)?\s*([\w$]+)", rest)
        if m:
          props[m.group(2)] = (_Parser(typ).parse(), bool(m.group(1)))
  return out


# ---------- type expressions ----------

_TOKEN = re.compile(r"\s*(=>|\.\.\.|'[^']*'|\"[^\"]*\"|-?\d+(?:\.\d+)?|[\w$]+|\S)")


class _Parser:
  OPAQUE = ("opaque",)

  def __init__(self, text: str) -> None:
    self.text = text
    self.toks = [t for t in _TOKEN.findall(text) if t]
    self.i = 0

  def peek(self):
    return self.toks[self.i] if self.i < len(self.toks) else None

  def take(self, want: str | None = None):
    tok = self.peek()
    if want is not None and tok != want:
      raise ValueError(f"expected {want!r}, got {tok!r} in {self.text!r}")
    self.i += 1
    return tok

  def parse(self):
    try:
      t = self.union()
      if self.peek() is not None:
        return self.OPAQUE
      return t
    except (ValueError, IndexError):
      return self.OPAQUE

  def union(self):
    if self.peek() == "|":
      self.take()
    parts = [self.inter()]
    while self.peek() == "|":
      self.take()
      parts.append(self.inter())
    return parts[0] if len(parts) == 1 else ("union", parts)

  def inter(self):
    parts = [self.postfix()]
    while self.peek() == "&":
      self.take()
      parts.append(self.postfix())
    return parts[0] if len(parts) == 1 else ("inter", parts)

  def postfix(self):
    t = self.primary()
    while self.peek() == "[" and self.i + 1 < len(self.toks) and self.toks[self.i + 1] == "]":
      self.take()
      self.take()
      t = ("array", t)
    return t

  def generic_args(self):
    self.take("<")
    args = [self.union()]
    while self.peek() == ",":
      self.take()
      args.append(self.union())
    self.take(">")
    return args

  def primary(self):
    tok = self.take()
    if tok is None:
      raise ValueError("unexpected end")
    if tok == "(":
      if self.peek() == ")":  # a function type
        raise ValueError("function type")
      t = self.union()
      self.take(")")
      if self.peek() == "=>":
        raise ValueError("function type")
      return t
    if tok == "{":
      return self.object_literal()
    if tok[0] in "'\"":
      return ("lit", tok[1:-1])
    if re.fullmatch(r"-?\d+(?:\.\d+)?", tok):
      return ("lit", float(tok))
    if tok == "import":
      self.take("(")
      spec = self.take()[1:-1]
      self.take(")")
      names = []
      while self.peek() == ".":
        self.take()
        names.append(self.take())
      return ("import", spec, names[-1])
    if tok in ("string", "number", "boolean", "null", "undefined", "any", "unknown", "object", "true", "false"):
      if tok in ("true", "false"):
        return ("prim", "boolean")
      return ("prim", tok)
    if tok in ("Array", "Object", "Record"):
      if self.peek() != "<":
        return ("prim", "object") if tok != "Array" else ("array", ("prim", "any"))
      args = self.generic_args()
      if tok == "Array":
        return ("array", args[0])
      return ("map", args[-1])
    if re.fullmatch(r"[A-Za-z_$][\w$]*", tok):
      if self.peek() == "<":
        self.generic_args()
        return self.OPAQUE
      return ("ref", tok)
    raise ValueError(f"unexpected {tok!r}")

  def object_literal(self):
    props: dict[str, tuple[object, bool]] = {}
    while self.peek() != "}":
      key = self.take()
      if key and key[0] in "'\"":
        key = key[1:-1]
      optional = False
      if self.peek() == "?":
        self.take()
        optional = True
      self.take(":")
      props[key] = (self.union(), optional)
      if self.peek() in (",", ";"):
        self.take()
    self.take("}")
    return ("obj", props)


# ---------- resolution and checking ----------


class Registry:
  """Typedefs by (file, name), parsed on first use."""

  def __init__(self) -> None:
    self._files: dict[str, dict[str, object]] = {}

  def defs(self, rel: str) -> dict[str, object]:
    if rel not in self._files:
      self._files[rel] = typedefs_in(REPO_ROOT / rel)
    return self._files[rel]

  def lookup(self, rel: str, name: str):
    """The type named `name` as seen from file `rel`, or a type expression
    like `Place[]`."""
    if not re.fullmatch(r"[\w$]+", name):
      return rel, _Parser(name).parse()
    defs = self.defs(rel)
    if name not in defs:
      raise KeyError(f"no @typedef {name} in {rel}")
    return rel, defs[name]

  def resolve(self, rel: str, t):
    """Follow refs and imports until a structural type, keeping the file each
    one was declared in."""
    seen = 0
    while t[0] in ("ref", "import"):
      seen += 1
      if seen > 20:
        raise ValueError("typedef cycle")
      if t[0] == "ref":
        defs = self.defs(rel)
        if t[1] not in defs:
          return rel, _Parser.OPAQUE
        t = defs[t[1]]
      else:
        rel = _normalise(f"{Path(rel).parent.as_posix()}/{t[1]}")
        defs = self.defs(rel)
        if t[2] not in defs:
          raise KeyError(f"no @typedef {t[2]} in {rel}")
        t = defs[t[2]]
    return rel, t

  def check(self, rel: str, t, value, where: str = "body") -> list[str]:
    rel, t = self.resolve(rel, t)
    kind = t[0]
    if kind == "opaque":
      return []
    if kind == "prim":
      name = t[1]
      ok = {
        "any": True,
        "unknown": True,
        "string": isinstance(value, str),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "null": value is None,
        "undefined": False,
        "object": isinstance(value, dict),
      }[name]
      return [] if ok else [f"{where}: {_js_type(value)} where the typedef says {name}"]
    if kind == "lit":
      return [] if value == t[1] else [f"{where}: {value!r} where the typedef says {t[1]!r}"]
    if kind == "array":
      if not isinstance(value, list):
        return [f"{where}: {_js_type(value)} where the typedef says an array"]
      errs = []
      for i, item in enumerate(value):
        errs += self.check(rel, t[1], item, f"{where}[{i}]")
      return errs
    if kind == "map":
      if not isinstance(value, dict):
        return [f"{where}: {_js_type(value)} where the typedef says an object"]
      errs = []
      for k, item in value.items():
        errs += self.check(rel, t[1], item, f"{where}.{k}")
      return errs
    if kind == "union":
      tried = []
      for alt in t[1]:
        errs = self.check(rel, alt, value, where)
        if not errs:
          return []
        tried += errs
      return [f"{where}: matches no member of the union ({'; '.join(tried)})"]
    if kind == "inter":
      props: dict[str, tuple[str, object, bool]] = {}
      errs = []
      stack = [(rel, part) for part in t[1]]
      while stack:
        prel, pt = self.resolve(*stack.pop(0))
        if pt[0] == "obj":
          for k, (pty, opt) in pt[1].items():
            props[k] = (prel, pty, opt)
        elif pt[0] == "inter":
          stack = [(prel, part) for part in pt[1]] + stack
        else:
          errs += self.check(prel, pt, value, where)
      return errs + self._check_obj(props, value, where)
    if kind == "obj":
      return self._check_obj({k: (rel, pty, opt) for k, (pty, opt) in t[1].items()}, value, where)
    raise ValueError(f"unknown type node {t!r}")

  def _check_obj(self, props, value, where):
    if not isinstance(value, dict):
      return [f"{where}: {_js_type(value)} where the typedef says an object"]
    errs = []
    for k in value:
      if k not in props:
        errs.append(f"{where}.{k}: sent but not declared in the typedef")
    for k, (prel, pty, opt) in props.items():
      if k not in value:
        if not opt:
          errs.append(f"{where}.{k}: required by the typedef but not sent")
        continue
      errs += self.check(prel, pty, value[k], f"{where}.{k}")
    return errs


def _normalise(rel: str) -> str:
  parts: list[str] = []
  for p in rel.split("/"):
    if p == "..":
      parts.pop()
    elif p not in (".", ""):
      parts.append(p)
  return "/".join(parts)


def _js_type(value) -> str:
  if value is None:
    return "null"
  if isinstance(value, bool):
    return "boolean"
  if isinstance(value, (int, float)):
    return "number"
  if isinstance(value, str):
    return "string"
  if isinstance(value, list):
    return "array"
  return "object"


def check_body(reg: Registry, rel: str, name: str, where: str | None, body) -> tuple[list[str], int]:
  """Errors for one response body, and how many values were checked against
  the typedef (0 means an empty list proved nothing)."""
  rel, t = reg.lookup(rel, name)
  if where is None:
    count = len(body) if isinstance(body, list) else 1
    return reg.check(rel, t, body), count
  key = where.removesuffix("[]")
  if not isinstance(body, dict) or not isinstance(body.get(key), list):
    return [f"body.{key}: not a list"], 0
  items = body[key]
  errs = []
  for i, item in enumerate(items):
    errs += reg.check(rel, t, item, f"body.{key}[{i}]")
  return errs, len(items)
