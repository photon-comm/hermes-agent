#!/usr/bin/env node
// Reference checker for photon.jsonc (spec version 1).
//
//   node tools/check.mjs <path/to/photon.jsonc> [--today=YYYY-MM-DD] [--normalized]
//
// What it does, in the order a reader must:
//   1. parse JSONC (comments and trailing commas allowed), at most 64 KiB;
//   2. stop early on a spec version or compatibility date newer than this
//      reader knows ("needs a newer Photon"), before anything else is judged;
//   3. validate the structure against schema/v1.json;
//   4. check what a schema can't: dates, features newer than the date,
//      collisions, reserved names, secrets written into the file, hosts that
//      can't deliver the way the template receives;
//   5. upgrade-on-read: print the canonical form every Photon service works
//      from (--normalized), with every default filled in.
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseTree, findNodeAtLocation, printParseErrorCode, getNodeValue } from "jsonc-parser";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(here, "../schema/v1.json"), "utf8"));

// ---- What this reader knows ------------------------------------------------

/** Spec majors this reader can read, oldest first. */
const SPEC_VERSIONS = [1];
/** The first and the latest compatibility date this reader implements. */
const EARLIEST_DATE = "2026-10-13";
const LATEST_DATE = "2026-10-13";
/**
 * When each closed-enum value and field became valid. A manifest that uses
 * one must carry a compatibility date on or after it. Everything in v1 is in
 * the baseline; later additions get their own dates here.
 */
const SINCE = {
  "channels.imessage": "2026-10-13",
  "delivery.webhook": "2026-10-13",
  "delivery.stream": "2026-10-13",
  "signature.spectrum-v0": "2026-10-13",
  "signature.standard-webhooks": "2026-10-13",
  "hosts.vercel": "2026-10-13",
  "hosts.railway": "2026-10-13",
  "hosts.docker": "2026-10-13",
  "hosts.source": "2026-10-13",
};
/** Compatibility flags this reader understands (none yet). Unknown ones stop the read. */
const FLAGS = new Set();
/** What each host can receive. Vercel functions can't hold a stream open. */
const HOST_DELIVERY = {
  vercel: ["webhook"],
  railway: ["webhook", "stream"],
  docker: ["webhook", "stream"],
  source: ["webhook", "stream"],
};
const RESERVED_ENV = new Set(["PATH", "HOME", "PORT", "PWD", "SHELL"]);
const RESERVED_PREFIXES = ["PHOTON_INTERNAL_", "VERCEL_", "RAILWAY_", "CF_", "NOW_"];
const SECRET_SHAPES = [
  /\bpho_sk_[A-Za-z0-9_]{8,}/,
  /\bwhsec_[A-Za-z0-9+/=]{16,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bxox[abps]-[A-Za-z0-9-]{10,}/,
];
const MAX_BYTES = 64 * 1024;
/** Binding sources whose value is a list. */
const LIST_SOURCES = new Set(["photon.owner.phones"]);

/** What a closed value at each place is called, for "isn't one Photon knows". */
const CLOSED_VALUES = [
  [/^\/channels\/\d+\/type$/, "channel type"],
  [/^\/delivery\/type$/, "delivery type"],
  [/^\/delivery\/signature$/, "signature scheme"],
  [/^\/delivery\/events\/\d+$/, "event"],
  [/^\/bindings\/[^/]+(\/from)?$/, "binding source"],
  [/^\/vars\/[^/]+\/type$/, "variable type"],
  [/^\/defaultHost$/, "host"],
];

// ---- Run ---------------------------------------------------------------------

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const today = args.find((a) => a.startsWith("--today="))?.slice(8) ?? new Date().toISOString().slice(0, 10);
const printNormalized = args.includes("--normalized");
if (!file) {
  console.error("usage: check.mjs <photon.jsonc> [--today=YYYY-MM-DD] [--normalized]");
  process.exit(2);
}

const text = readFileSync(file, "utf8");
const diagnostics = [];
const report = (severity, code, message, path = []) => diagnostics.push({ severity, code, message, path });

const parseErrors = [];
const tree = parseTree(text, parseErrors, { allowTrailingComma: true, disallowComments: false });
if (Buffer.byteLength(text) > MAX_BYTES) report("error", "E_TOO_LARGE", `The file is over ${MAX_BYTES / 1024} KiB.`);
for (const e of parseErrors) {
  report("error", "E_PARSE", printParseErrorCode(e.error), { offset: e.offset });
}
const doc = tree && parseErrors.length === 0 ? getNodeValue(tree) : null;

if (doc && typeof doc === "object" && !Array.isArray(doc)) {
  checkVersions(doc) && checkSchema(doc) && checkMeaning(doc);
} else if (parseErrors.length === 0) {
  report("error", "E_NOT_OBJECT", "The manifest must be a JSON object.");
}

for (const d of diagnostics) {
  const at = locate(d.path);
  console.log(`${file}:${at.line}:${at.column} ${d.severity} ${d.code} ${d.message}`);
}
const errors = diagnostics.filter((d) => d.severity === "error").length;
if (errors === 0 && printNormalized) console.log(JSON.stringify(normalize(doc), null, 2));
if (errors === 0) console.log(`${file}: ok${diagnostics.length ? ` (${diagnostics.length} warning(s))` : ""}`);
process.exit(errors === 0 ? 0 : 1);

// ---- 2. Versions first: a reader must know what it's reading ----------------

function checkVersions(doc) {
  const spec = doc.specVersion;
  if (typeof spec === "number" && Number.isInteger(spec) && spec > Math.max(...SPEC_VERSIONS)) {
    report("error", "E_SPEC_TOO_NEW", `Spec version ${spec} needs a newer Photon; this one reads ${SPEC_VERSIONS.join(", ")}.`, ["specVersion"]);
    return false;
  }
  const date = doc.compatibilityDate;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    if (!isCalendarDate(date)) {
      report("error", "E_DATE_INVALID", `${date} isn't a calendar date.`, ["compatibilityDate"]);
      return false;
    }
    if (date > LATEST_DATE) {
      report("error", "E_DATE_TOO_NEW", `Compatibility date ${date} needs a newer Photon; this one goes up to ${LATEST_DATE}.`, ["compatibilityDate"]);
      return false;
    }
    if (date > today) report("error", "E_DATE_IN_FUTURE", `Compatibility date ${date} is after today (${today}).`, ["compatibilityDate"]);
    if (date < EARLIEST_DATE) report("error", "E_DATE_TOO_OLD", `Compatibility dates start at ${EARLIEST_DATE}.`, ["compatibilityDate"]);
  }
  for (const [i, flag] of (Array.isArray(doc.compatibilityFlags) ? doc.compatibilityFlags : []).entries()) {
    if (!FLAGS.has(flag.replace(/^no_/, ""))) {
      report("error", "E_FLAG_UNKNOWN", `Compatibility flag ${flag} needs a newer Photon, or is misspelled.`, ["compatibilityFlags", i]);
    }
  }
  return true;
}

// ---- 3. Structure ------------------------------------------------------------

function checkSchema(doc) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(SCHEMA);
  // Validate the branch the document chose, so a template never hears about
  // a workspace's required fields and the other way round.
  const kind = doc.kind === "workspace" ? "workspace" : "template";
  const validate = ajv.getSchema(`${SCHEMA.$id}#/$defs/${kind}`);
  if (validate(doc)) return true;

  const errors = validate.errors;
  const unknownAt = new Set();
  for (const e of errors) {
    const value = valueAt(doc, e.instancePath);
    const named = CLOSED_VALUES.find(([pattern]) => pattern.test(e.instancePath));
    if ((e.keyword === "enum" || e.keyword === "const") && typeof value === "string" && named && !unknownAt.has(e.instancePath)) {
      unknownAt.add(e.instancePath);
      report(
        "error",
        "E_UNKNOWN_VALUE",
        `"${value}" isn't a ${named[1]} Photon knows. It may be misspelled, or need a later compatibility date and a newer Photon.`,
        pointerPath(e.instancePath),
      );
    }
  }
  const seen = new Set();
  for (const e of errors) {
    // Noise around an unknown value: the union it failed and its other branches.
    if ([...unknownAt].some((p) => p === e.instancePath || p.startsWith(`${e.instancePath}/`))) continue;
    if (e.keyword === "if") continue;
    let what = e.message;
    if (e.keyword === "additionalProperties") {
      what = `unknown field "${e.params.additionalProperty}" (misspelled? extensions start with x-)`;
    } else if (e.keyword === "not" && /^\/vars\/[^/]+$/.test(e.instancePath)) {
      const v = valueAt(doc, e.instancePath);
      what = v.generate ? "a generated variable takes no default or placeholder" : "a secret variable can't have a default";
    }
    const key = `${e.instancePath} ${what}`;
    if (seen.has(key)) continue;
    seen.add(key);
    report("error", "E_SCHEMA", `${e.instancePath || "(root)"}: ${what}.`, pointerPath(e.instancePath));
  }
  return false;
}

function pointerPath(pointer) {
  return pointer.split("/").slice(1).map(unescapePointer);
}

function valueAt(doc, pointer) {
  return pointerPath(pointer).reduce((value, key) => (value == null ? value : value[key]), doc);
}

// ---- 4. Meaning ---------------------------------------------------------------

function checkMeaning(doc) {
  const date = doc.compatibilityDate;
  const needs = (feature, path) => {
    const since = SINCE[feature];
    if (since && date < since) report("error", "E_FEATURE_NEEDS_DATE", `${feature} needs a compatibility date of ${since} or later.`, path);
  };

  if (doc.kind === "workspace") {
    const base = dirname(resolve(file));
    for (const [i, pattern] of doc.templates.entries()) {
      const dir = resolve(base, pattern.replace(/\/\*$/, ""));
      if (!existsSync(dir)) report("warning", "W_PATH_MISSING", `${pattern} doesn't exist next to this file.`, ["templates", i]);
    }
    return;
  }

  doc.channels.forEach((c, i) => needs(`channels.${c.type}`, ["channels", i, "type"]));
  needs(`delivery.${doc.delivery.type}`, ["delivery", "type"]);
  if (doc.delivery.signature) needs(`signature.${doc.delivery.signature}`, ["delivery", "signature"]);
  for (const host of Object.keys(doc.hosts).filter((h) => !h.startsWith("x-"))) needs(`hosts.${host}`, ["hosts", host]);

  // Names: what Photon writes and what the person fills in share one namespace.
  const bindings = doc.bindings ?? {};
  const vars = doc.vars ?? {};
  for (const [section, names] of [["bindings", Object.keys(bindings)], ["vars", Object.keys(vars)]]) {
    for (const name of names) {
      if (RESERVED_ENV.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
        report("error", "E_ENV_RESERVED", `${name} is reserved for Photon or the host.`, [section, name]);
      }
    }
  }
  for (const name of Object.keys(vars)) {
    if (name in bindings) report("error", "E_ENV_COLLISION", `${name} is both a binding and a variable.`, ["vars", name]);
  }

  // Bindings that only exist with something else in place.
  for (const [name, binding] of Object.entries(bindings)) {
    const from = typeof binding === "string" ? binding : binding.from;
    if (from === "photon.webhook.secret" && doc.delivery.type !== "webhook") {
      report("error", "E_BINDING_NEEDS_WEBHOOK", `${name} takes the webhook's secret, but delivery isn't a webhook.`, ["bindings", name]);
    }
  }
  if (!Object.values(bindings).some((b) => (typeof b === "string" ? b : b.from) === "photon.project.secret")) {
    report("warning", "W_NO_PROJECT_SECRET", "No binding takes photon.project.secret; the agent can't reach Photon without it.", ["bindings"]);
  }

  // Variables: defaults that fit their type, options and pattern.
  for (const [name, v] of Object.entries(vars)) {
    const type = v.type ?? "string";
    if ("default" in v) {
      const d = v.default;
      const fits =
        type === "boolean" ? typeof d === "boolean" : type === "integer" ? Number.isInteger(d) : typeof d === "string";
      if (!fits) report("error", "E_VAR_DEFAULT", `${name}'s default isn't a ${type}.`, ["vars", name, "default"]);
      else if (type === "enum" && !v.options.some((o) => (typeof o === "string" ? o : o.value) === d)) {
        report("error", "E_VAR_DEFAULT", `${name}'s default isn't one of its options.`, ["vars", name, "default"]);
      } else if (v.pattern && typeof d === "string" && !new RegExp(v.pattern).test(d)) {
        report("error", "E_VAR_DEFAULT", `${name}'s default doesn't match its pattern.`, ["vars", name, "default"]);
      }
    }
    if (v.required === true && "default" in v) {
      report("warning", "W_REQUIRED_WITH_DEFAULT", `${name} is required and has a default; the default always fills it.`, ["vars", name, "required"]);
    }
  }

  // Hosts: each must be able to receive messages the way this template does.
  const hostIds = Object.keys(doc.hosts).filter((h) => !h.startsWith("x-"));
  for (const host of hostIds) {
    if (!HOST_DELIVERY[host].includes(doc.delivery.type)) {
      report("error", "E_HOST_DELIVERY", `${host} can't receive by ${doc.delivery.type}.`, ["hosts", host]);
    }
  }
  if (doc.defaultHost && !hostIds.includes(doc.defaultHost)) {
    report("error", "E_DEFAULT_HOST", `defaultHost ${doc.defaultHost} isn't one of hosts.`, ["defaultHost"]);
  }
  if (!doc.defaultHost && hostIds.filter((h) => h !== "source").length > 1) {
    report("warning", "W_NO_DEFAULT_HOST", "Several hosts and no defaultHost; Photon offers the first one listed.", ["hosts"]);
  }

  // Files the manifest points into must be inside the template's directory.
  const base = dirname(resolve(file));
  if (doc.icon && !existsSync(resolve(base, doc.icon))) {
    report("error", "E_ICON_MISSING", `${doc.icon} doesn't exist.`, ["icon"]);
  }

  // No secret ever lives in the manifest.
  walk(doc, [], (value, path) => {
    if (typeof value !== "string" || path[0] === "$schema") return;
    if (SECRET_SHAPES.some((shape) => shape.test(value))) {
      report("error", "E_SECRET_LITERAL", "This looks like a real secret. Secrets are bindings or variables, never values in the file.", path);
    }
  });
}

// ---- 5. Upgrade-on-read: the canonical model --------------------------------

function normalize(doc) {
  if (doc.kind === "workspace") return { ...strip(doc), kind: "workspace" };
  const hostIds = Object.keys(doc.hosts).filter((h) => !h.startsWith("x-"));
  const vars = Object.fromEntries(
    Object.entries(doc.vars ?? {}).map(([name, v]) => {
      const type = v.type ?? "string";
      const generated = Boolean(v.generate);
      return [
        name,
        {
          ...strip(v),
          type,
          required: v.required ?? (!("default" in v) && !generated),
          advanced: v.advanced ?? false,
          ...(generated ? { generate: { bytes: 32, encoding: "hex", ...v.generate } } : {}),
        },
      ];
    }),
  );
  return {
    specVersion: doc.specVersion,
    compatibilityDate: doc.compatibilityDate,
    compatibilityFlags: doc.compatibilityFlags ?? [],
    kind: "template",
    name: doc.name,
    version: doc.version,
    title: doc.title,
    description: doc.description,
    icon: doc.icon ?? null,
    categories: doc.categories ?? [],
    author: doc.author ?? null,
    license: doc.license ?? null,
    links: strip(doc.links ?? {}),
    demo: doc.demo ?? {},
    channels: doc.channels.map((c) =>
      c.type === "imessage"
        ? { type: "imessage", lines: c.lines ?? ["shared", "dedicated"], defaultLine: c.defaultLine ?? "shared" }
        : strip(c),
    ),
    delivery:
      doc.delivery.type === "webhook"
        ? { ...strip(doc.delivery), events: doc.delivery.events ?? ["message.received"] }
        : strip(doc.delivery),
    bindings: Object.fromEntries(
      Object.entries(doc.bindings ?? {}).map(([name, b]) => [
        name,
        bindingModel(typeof b === "string" ? { from: b } : b),
      ]),
    ),
    vars,
    hosts: Object.fromEntries(
      hostIds.map((h) => [h, hostDefaults(h, strip(doc.hosts[h]))]),
    ),
    defaultHost: doc.defaultHost ?? hostIds[0],
    checks: {
      online: doc.checks?.online ?? { type: "delivery" },
      done: { type: "first-reply", timeoutSeconds: 600, ...(doc.checks?.done ?? {}) },
    },
  };
}

/** Only a list has a format; a single value is written as it is. */
function bindingModel({ from, format }) {
  return LIST_SOURCES.has(from) ? { from, format: format ?? "csv" } : { from };
}

function hostDefaults(host, block) {
  switch (host) {
    case "vercel":
      return { rootDirectory: ".", environments: ["production"], ...block };
    case "railway":
      return {
        rootDirectory: ".",
        build: { type: "dockerfile", path: "Dockerfile" },
        volumes: [],
        replicas: 1,
        restartPolicy: "on-failure",
        ...block,
      };
    case "docker":
      return { dockerfile: "Dockerfile", volumes: [], ...block };
    case "source":
      return { envFile: ".env", ...block };
    default:
      return block;
  }
}

// ---- helpers -----------------------------------------------------------------

/** Drops x- extension fields: they travel with the file but never into the model. */
function strip(object) {
  return Object.fromEntries(Object.entries(object).filter(([k]) => !k.startsWith("x-") && k !== "$schema"));
}

function walk(value, path, visit) {
  visit(value, path);
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(v, [...path, Array.isArray(value) ? Number(k) : k], visit);
  }
}

function isCalendarDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function unescapePointer(segment) {
  const s = segment.replace(/~1/g, "/").replace(/~0/g, "~");
  return /^\d+$/.test(s) ? Number(s) : s;
}

function locate(path) {
  let offset = 0;
  if (path && typeof path === "object" && "offset" in path) offset = path.offset;
  else if (tree && Array.isArray(path)) {
    const node = findNodeAtLocation(tree, path) ?? (path.length ? findNodeAtLocation(tree, path.slice(0, -1)) : tree);
    offset = node?.parent?.type === "property" ? node.parent.offset : node?.offset ?? 0;
  }
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1].length + 1 };
}
