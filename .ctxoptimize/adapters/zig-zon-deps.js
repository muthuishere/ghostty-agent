#!/usr/bin/env node
// ctx-optimize adapter — Zig package dependencies from build.zig.zon.
//
// Why an adapter and not a manifest pack: manifest-pack rules only parse
// {json,xml,yaml}, and ZON is none of those. `deps` ships npm/go/maven/gradle/
// nuget/pypi/crates — Zig is not covered, so this is the documented adapter
// door. Emits the same node/edge shape the built-in manifests lane uses
// (dep:<ecosystem>/<name> + a `declares` edge from the manifest file), so
// `ctx-optimize deps` answers for Zig exactly as it does for crates.
//
// ZON shape consumed:
//   .dependencies = .{
//       .libxev = .{ .url = "...", .hash = "...", .lazy = true },
//       .iterm2_themes = .{ .path = "./vendor/..." },
//   }
// Zig declares no semver range for a dependency — the hash IS the pin, so it
// is recorded as version_spec.

const fs = require("fs");
const path = require("path");

const SKIP = new Set([".git", "zig-out", ".zig-cache", "zig-cache", "node_modules", ".ctxoptimize"]);
const ECOSYSTEM = "zig";

function findZon(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      findZon(path.join(dir, e.name), out);
    } else if (e.name === "build.zig.zon") {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// Strip // line comments that are not inside a string literal. URLs contain
// "//" and every dep has one, so a naive strip would eat the .url values.
function stripComments(src) {
  let out = "";
  for (const line of src.split("\n")) {
    let inStr = false, cut = line.length;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inStr) {
        if (c === "\\") { i++; continue; }
        if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === "/" && line[i + 1] === "/") {
        cut = i; break;
      }
    }
    out += line.slice(0, cut) + "\n";
  }
  return out;
}

// Return [start,end) of the .{ ... } block whose opening brace is at or after
// `from`, brace-matched and string-aware.
function block(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0, inStr = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return [open + 1, i]; }
  }
  return null;
}

function field(body, name) {
  const re = new RegExp("\\." + name + '\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"');
  const m = body.match(re);
  return m ? m[1] : null;
}

function boolField(body, name) {
  const m = body.match(new RegExp("\\." + name + "\\s*=\\s*(true|false)"));
  return m ? m[1] === "true" : false;
}

const nodes = new Map();
const edges = [];
const root = process.cwd();

for (const file of findZon(root, [])) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  let src;
  try { src = stripComments(fs.readFileSync(file, "utf8")); } catch { continue; }

  const anchor = src.search(/\.dependencies\s*=\s*\./);
  if (anchor < 0) continue;
  const span = block(src, anchor);
  if (!span) continue;
  const deps = src.slice(span[0], span[1]);

  // Walk top-level `.name = .{ ... }` entries inside the dependencies block.
  const entry = /\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\./g;
  let m;
  while ((m = entry.exec(deps)) !== null) {
    const name = m[1];
    const inner = block(deps, entry.lastIndex);
    if (!inner) continue;
    const body = deps.slice(inner[0], inner[1]);
    entry.lastIndex = inner[1]; // skip nested fields; only siblings are deps

    const url = field(body, "url");
    const hash = field(body, "hash");
    const local = field(body, "path");
    if (!url && !hash && !local) continue; // not a dependency entry

    const id = `dep:${ECOSYSTEM}/${name}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: name,
        kind: "dependency",
        file_type: "manifest",
        source: `dep://${ECOSYSTEM}/${name}`,
        scope: "runtime",
        metadata: {
          ecosystem: ECOSYSTEM,
          scopes: "runtime",
          ...(local ? { vendored: "true" } : {}),
        },
      });
    }
    edges.push({
      source: rel,
      target: id,
      relation: "declares",
      confidence: "EXTRACTED",
      metadata: {
        scope: "dependencies",
        scope_class: "runtime",
        version_spec: hash || local || url || "",
        ...(url ? { url } : {}),
        ...(local ? { path: local } : {}),
        ...(boolField(body, "lazy") ? { lazy: "true" } : {}),
      },
    });
  }
}

console.log(JSON.stringify({
  producer: "zig-zon-deps",
  nodes: [...nodes.values()],
  edges,
}));
