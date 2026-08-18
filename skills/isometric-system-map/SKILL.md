---
name: isometric-system-map
description: Generate an interactive isometric system map of a codebase — infrastructure drawn as varied 3D buildings on a grid, with a legend, an explainer panel, palisade boundaries, and dependency lines tracing real control and data paths. Every building and every line cites the actual files behind it. Use when asked to map, diagram, survey, or visualise a repository's architecture, or for requests like "isometric map", "system map", "architecture diagram", "show me how this system fits together".
---

# Isometric system map

Produce one self-contained HTML file: an isometric city where every building is a
real part of the system, sized by its real weight, wired by its real dependencies,
and backed by `file:line` citations a reader can open.

The renderer is deterministic and already written. **Your job is research, not
geometry** — survey the repository, then write a truthful `system.json`.

A map whose citations are invented is worse than no map. Nothing goes in the spec
that you have not read.

## The loop

```
survey → write system.json → make validate → make render → make shots → look → fix
```

```bash
SKILL=~/.pi/agent/skills/isometric-system-map

make -C $SKILL validate SPEC=/abs/system.json ROOT=/abs/repo
make -C $SKILL render   SPEC=/abs/system.json ROOT=/abs/repo OUT=/abs/system-map.html
make -C $SKILL shots    OUT=/abs/system-map.html          # PNGs of every state
make -C $SKILL demo                                       # the bundled fixture
```

`ROOT` is the repo being mapped — every citation resolves against it.
`make demo` renders `example/system.json` against `example/tree/`; read that spec
as the worked reference for tone, density and citation style.

## 1. Survey before you draw

Never sketch the map from a directory listing. Establish, in this order:

1. **Entry points** — what starts? `main`, server bootstrap, CLI, workers, cron,
   lambda handlers, `bin/`, `if __name__`, `package.json` scripts.
2. **Deployment reality** — Dockerfiles, compose, k8s manifests, Terraform, CI
   workflows, Procfiles. This is where boundaries and replica counts come from,
   and it is the part most maps get wrong by guessing.
3. **The spine** — follow one request or one event end to end, by reading. That
   walk becomes the primary `flow`.
4. **Everything hanging off it** — stores, queues, shared libraries, auth, config,
   observability, schedulers.

Then fan out **read-only subagents, one per subsystem, in parallel** (a single
message with several `Agent` calls, `run_in_background: true`). Brief each one to
return, for its subsystem only:

- proposed nodes: name, what it does in plain words, what it is built from
- the exact files and line ranges that implement it
- outgoing dependencies, each with the **call site** that creates it
- known defects: TODOs, dead code, missing tests, unfinished migrations

Reject anything a subagent returns without a line-range you can check. Spot-check
citations by reading them yourself before they reach the spec — `make validate`
proves a path exists, not that it says what you claimed.

## 2. Choosing buildings

**Cap: ~28 per level, hard maximum 40.** Past that the city is unreadable and the
renderer refuses. This limit is a feature — it forces the editorial judgement that
makes a map worth reading. Merge related parts into one district-level building and
push the detail into `children`.

A building earns its place if a maintainer would name it in conversation. A file is
not a building. A folder is not a building. `utils/` is never a building.

### Shape is meaning

| shape   | means                                          |
| ------- | ---------------------------------------------- |
| `block` | a service or process — runs, holds logic       |
| `slab`  | shared library everyone stands on              |
| `stack` | store, archive, versioned or layered data      |
| `fins`  | replicated workers — **one fin per replica**   |
| `plate` | thin adapter, config, binding                  |
| `tower` | measurement, observability, or a gate all traffic passes |

Massing is data, not taste: `complexity` (1-5) drives height, `surface` (1-5)
drives footprint, `replicas` sets fin count, `layers` sets stack plates. Take
replica counts from the deployment files and cite them. A tall building is a claim
that something is genuinely complicated — be able to defend it.

### Codes

1-2 character mnemonic worn on the roof: `P` for the archive it **P**ersists, `AU`
for the **AU**th gate. Never A, B, C in layout order. Children take the parent's
letter and a digit (`A1`, `A2`). The legend's right-hand number is that node's
citation count — a low number on an important building means you have not finished
researching it.

## 3. Lines that mean something

- `control` — a synchronous call. A makes B do something and waits.
- `data` — a payload moves.
- `async` — queue, event, cron, poll. Decoupled in time.

Cite the **call site**, not the module: the line where the dependency is actually
created (`await appendToLog(env)`), not the file that happens to contain it.

Draw the dependencies that carry the system's behaviour. Every import is not an
edge; a graph that includes them shows nothing. If two buildings exchange nothing
at runtime, they are not connected.

## 4. Palisades

A palisade wraps everything inside **one runtime boundary** — a process, a
deployment unit, a trust zone, a network edge. Crossing one costs serialisation,
auth, or latency, and the map exists to make that visible.

Do not draw palisades around source folders. A monolith with one process gets one
palisade, or none.

`"state": "planned"` draws the wall dashed: built, tested, and not switched on.
Rewrites, feature-flagged paths, and half-finished migrations belong here — being
honest about them is usually the most valuable thing on the map.

## 5. Writing the panel

Three fields per building. Different jobs, different voices:

- **`does`** — plain language, no jargon, no framework names. What would be lost if
  you deleted it. A new engineer should understand it.
- **`built`** — the mechanism. How it works, and the thing that surprised you.
- **`condition`** — what is currently wrong. Known bugs, TODOs, dead code, missing
  tests, perf cliffs, stalled migrations. Omit only when genuinely clean.

`condition` is the field that makes the map worth keeping. Do not soften it and do
not invent it. "No dead-letter path — a segment that throws stalls its shard
permanently" is useful; "could be improved" is not.

Wrap a phrase in `[[double brackets]]` to highlight it inline. Use it two or three
times across the whole document, on the sentences that carry the real point.

`meta.stats` are domain counters a maintainer would want on the wall — replica
counts, generations, engines, boundaries. Never node/edge totals.

### Flows

At least one flow, told as an event: "An event arrives". One caption per hop,
naming what actually happens. This is the animated trace, and it is how most people
will read the map — write the captions as narration, not as labels.

## 6. Look at what you made

`make shots` writes PNGs of the overview, a selection, the built tab, a flow step,
an interior, and the legend. **Open every one.** Check for:

- buildings colliding or hidden behind taller neighbours
- wires crossing under unrelated buildings, or endpoints that read ambiguously
- labels overlapping the city
- a composition sprawling diagonally with dead canvas — usually too many ranks;
  merge nodes or reconsider the spine
- anything a stranger would misread

Fix by adjusting the spec: merge nodes, change a `shape`, move something into
`children`, or pin a `cell`. Then render and look again.

Report the map done only after looking at the screenshots. "It validated" is not
"it is readable".

## Spec format

Full contract in `schema.json`; worked example in `example/system.json`.

```jsonc
{
  "meta": {
    "repo": "meridian · event pipeline",
    "title": "The Ingest Pipeline",
    "subtitle": "how an event gets accepted, enriched, filed and served",
    "stats": [{ "label": "Worker replicas", "value": "5" }],
    "intro": ["This repository is one write path and one read path sharing a store…"],
    "readIt": "Hover any building for a plain description…"
  },
  "groups":   [{ "id": "core", "name": "Node runtime", "kind": "deployment", "state": "live", "note": "…" }],
  "sections": [{ "id": "write", "title": "The write path" }],
  "nodes": [{
    "id": "log", "code": "L", "name": "Durable log", "shape": "stack",
    "section": "write", "group": "core",
    "metrics": { "complexity": 3, "surface": 3, "layers": 5 },
    "does": "…", "built": "…", "condition": "…",
    "cites": [{ "path": "src/queue/log.ts", "lines": "3-20", "note": "appendToLog, segment roll" }],
    "children": []
  }],
  "edges": [{
    "id": "e-gw-log", "from": "gateway", "to": "log", "kind": "control",
    "label": "awaited before the 202 goes back",
    "cites": [{ "path": "src/ingest/gateway.ts", "lines": "16", "note": "await appendToLog(…)" }]
  }],
  "flows": [{
    "id": "accept", "name": "An event arrives",
    "steps": [{ "edge": "e-gw-log", "caption": "The envelope is appended before the caller is acknowledged." }]
  }]
}
```

## What the reader gets

Drag to pan, scroll to zoom, click a building or legend row to select it, `↓↑` to
walk the legend, `↵` to go inside, `⎋` to come back out, space to run the flow,
`.` to step it. Selecting a building lifts the wires that touch it and fades the
rest; running a flow lifts the live wire above the rooftops.

## Rules

1. Never cite a file you have not read. Never guess a line number.
2. Never invent a `condition`, never hide one you found.
3. Boundaries come from deployment files, not from folder names.
4. Replica and layer counts come from config, and get cited.
5. Past ~28 buildings, abstract — do not shrink.
6. Look at the screenshots before saying it is done.
