# AGENTS.md

Guidelines for AI coding agents working in this repository.

## Project Overview

This is an **external OrangeLab stack**, separate from the `orange-lab` monorepo.
It deploys a Cardano relay, `cardano-db-sync`, PostgreSQL, a Midnight full node,
and an optional Midnight indexer. It consumes the published
`@orangelab/pulumi` package; there is no local copy of the library here.

The Pulumi stack is `lab-cardano`. Run Pulumi from the repository root.

Read [`README.md`](./README.md) for the stack layout,
[`RUNBOOK.md`](./RUNBOOK.md) for the operational walkthrough,
[`docs/longhorn.md`](./docs/longhorn.md) for storage,
[`SECURITY.md`](./SECURITY.md) for key management and incident response, and
[`evidence/README.md`](./evidence/README.md) for evidence capture. The runbook is
the source of truth for deployment and shutdown.

## External Stack Boundary

- This repo is not part of the `orange-lab` npm workspace. Do not edit
  `node_modules`, vendor library code, or import from
  `../orange-lab/packages/pulumi/src` directly.
- If a change belongs in `@orangelab/pulumi`, stop and propose a library change
  in the OrangeLab repo, then a released-version bump here. Do not work around a
  missing library feature with hand-written Kubernetes manifests.
- Paths such as `stacks/<module>/` and `packages/pulumi/src/` in the OrangeLab
  instructions belong to the parent repo, not this one.
- Keep the stack deployable from this directory alone. Do not assume sibling
  stacks, shared scripts, or local OrangeLab code are present.

## Commands

- Typecheck: `npm test` (`tsc --noEmit`). Skip for Markdown or comment-only
  changes.
- Preview: `pulumi preview --diff` (read-only).
- Deploy: `pulumi up --yes` — only with explicit user approval.
- Destroy: `pulumi destroy --yes` — only with explicit user approval. Confirm
  the storage mode first (see below).
- Run long `pulumi up`/`destroy` commands in the background so an interrupted
  tool call does not kill the update mid-flight.
- Never kill a running Pulumi update. If an update was interrupted externally,
  clear it with `pulumi cancel --yes`, then rerun. If it failed, rerun it to
  clear pending operations.
- After a state/cluster divergence, prefer `pulumi refresh --yes` then
  `pulumi up --yes -r` over hand-deleting individual resources.
- Shell: `bash -n scripts/<script>.sh`; run `shellcheck -x` when available.
  `npm test` does not cover shell scripts or Markdown.
- Python: `python3 -m py_compile scripts/*.py`; run `--help` for usage. The
  Section 3 scripts use only the standard library.
- Markdown: `npx prettier --write <files>` and `npx prettier --check <files>`.
  The repo config uses `printWidth: 90` and normalizes tables.

## Secrets and Stack Files

- Never read or modify `Pulumi.<stack>.yaml` (`Pulumi.lab-cardano.yaml`); it is
  gitignored and contains secrets. Use `pulumi config` / `pulumi config set`.
- `Pulumi.yaml` holds non-secret defaults and may be edited. Stack files override
  those defaults and stay local.
- `pulumi config` (the full listing) and `pulumi stack output` redact secrets
  unless `--show-secrets` is passed. Never pass `--show-secrets`.
- `pulumi config get <key>` always prints the plaintext value, including for
  secrets. Never run it on a secret key; give that command to the user to run in
  their own terminal.
- Do not put real hostnames, IPs, machine names, account names, domains, or
  other environment-identifying values in committed docs, comments, examples, or
  commit messages. Use `example.com`, `<node>`, `<stack>`, and similar
  placeholders.

## Architecture

- `index.ts` wires `Cardano` → `MidnightNode` → optional `MidnightIndexer`.
- `Cardano` owns the PostgreSQL database. It exposes `dbConfig` and
  `dbWaitContainer` (from `databases.getWaitContainer`); `MidnightNode` consumes
  both. Do not duplicate the database wait-container logic.
- `MidnightIndexer` requires a node built with `--state-pruning archive`. The
  default Midnight node is pruned, so the indexer stays disabled unless the node
  is rebuilt as an archive node.
- Use `Application` from `@orangelab/pulumi` for Kubernetes resources,
  namespaces, storage, services, and secrets. Do not add raw Kubernetes
  manifests for things the library already models.
- `cardano:network` and `midnight-node:network` must match. The bundled config
  uses `preprod`. Keep code, docs, and scripts network-agnostic; do not hardcode
  preprod or a testnet magic. Use `scripts/cardano-cli.sh`, which derives the
  network flag from `cardano:network`.
- Config defaults live in `Pulumi.yaml` only. Use `config.require*` for keys with
  defaults and `config.get*` + `??` only for genuinely optional settings. Never
  use an installation-specific value as a published default.
- Main containers declare their own `resources`; the library sizes init
  containers and database containers. Tune from measured RSS, not working set.

## Storage and Stack Lifecycle

- The default flow uses dynamic Longhorn volumes (`longhorn-large`). They survive
  `pulumi up` but are deleted by `pulumi destroy`.
- Named/static volumes use `fromVolume`. The underlying Longhorn volumes are
  external and must survive `pulumi destroy`. Before destroying, check that the
  stack config still points at the intended named volumes, and never delete the
  Longhorn volumes directly.
- Never create `cardano-db` as an empty static volume. CloudNativePG skips
  `initdb`, and PostgreSQL fails on `pgdata`. Clone the initialized
  `cardano-db-1` volume instead. The full clone/redeploy workflow is in
  [`docs/longhorn.md`](./docs/longhorn.md).
- `cardano:db/password` is restore-critical. Keep it stable across database
  restores. Do not print it; have the user read it from stack output in their own
  terminal.
- This repo manages only `lab-cardano`. Never run `pulumi destroy` against the
  core `organization/orangelab/lab` stack.
- The Cardano component has no `enabled` flag; it deploys on every `pulumi up`.
  Enable the Midnight node only after DB Sync has reached the Cardano tip.

## Components and Documentation

- A component lives in `components/<name>/<name>.ts` with a companion
  `<name>.md`.
- Keep component docs network-agnostic. Say “this stack defaults to preprod”,
  not “the component is preprod”.
- Keep `README.md` focused on the simple dynamic-storage path. Put static-volume
  details, failure modes, tuning, and troubleshooting in `RUNBOOK.md` or the
  component doc’s Gotchas section.
- Lead with the working quick start; put rationale and edge cases later. Prefer
  tables and short sections over long prose.
- After changing docs, check relative links/anchors and config keys against the
  code and `Pulumi.yaml`. Do not restate the config table in prose.
- The runbook’s main flow is deploy → verify Cardano/DB Sync → deploy Midnight →
  capture evidence. Keep advanced operations out of that path.

## Evidence and Scripts

- `evidence/capture-evidence.sh` writes one UTC-stamped directory under
  `evidence/`. Capture twice, at least 10 minutes apart, so the pair shows block
  progression. Evidence docs live in `evidence/README.md`. Remove older runs
  only after the new pair is verified.
- Evidence contains no secrets, but it can contain internal cluster IPs,
  hostnames, node names, and public on-chain data (addresses, transaction hashes,
  and amounts in Midnight logs). Do not add credentials or other secrets. Review
  it before publishing if identifying infrastructure data matters.
- `scripts/cardano-cli.sh` runs `cardano-cli` inside the Cardano pod and derives
  the network flag from `cardano:network` (`preprod` → 1, `preview` → 2,
  `mainnet` → `--mainnet`). Custom testnets use `CARDANO_NETWORK_MAGIC` or
  `cardano:networkMagic`.
- Scripts in this repo are stack-specific, unlike the generic shared tools in
  `orange-lab/scripts`. Shell scripts use `set -euo pipefail` and block section
  comments for distinct phases. Python scripts use the standard library only,
  `argparse`, and atomic state writes. Section 3 script usage lives in
  [`scripts/README.md`](./scripts/README.md).

## Code Style

- TypeScript with strict checking. Avoid `any`.
- camelCase for variables, functions, and methods; PascalCase for classes,
  interfaces, and type aliases.
- Group external imports first, then internal modules; sort alphabetically
  within each group.
- Use `assert` for invariants that should never fail.
- Prefer `variable?: Type` over `variable: Type | undefined`.
- Keep methods around 20 lines and files around 200–300 lines. Flag the refactor
  before growing an already oversized class or method.
- Use constructor parameter properties with access modifiers, composition over
  inheritance, and pass dependencies through args.
- Use `envSecret` for sensitive environment variables; never put passwords or
  tokens in command arguments.
- Read configuration through the `config` accessors, not `process.env`.

## Workflow and Principles

- Follow Understand → Discuss → Plan → Implement → Verify. Do not skip to
  implementation without agreement on direction.
- KISS and YAGNI: implement what is needed now, not hypothetical futures.
- Keep components loosely coupled and single-purpose; encapsulate complexity
  behind clean interfaces.
- Stop and discuss when a library change is needed, scope or assumptions change,
  a new cross-component dependency appears, or a method/file would cross the
  refactor threshold.
- Challenge poor fits: wrong layer, a pattern this repo does not use, or an
  option with worse consequences elsewhere. Say what you would do instead and
  let the user decide.
- Stay within the requested scope. Surface out-of-scope problems as a list
  rather than fixing them silently.
- Before reporting complete: run the relevant checks and inspect
  `git status --short`; surface related files split between staged and
  untracked instead of calling the change ready.
- Commit messages use conventional commits: `scope:` or `fix(scope):`. Use
  `scope!:` for breaking changes and include migration actions. Say why the
  change matters.

## Related Guidance

When the OrangeLab checkout is available at `../orange-lab`, these provide the
fuller rules behind this file:

- [`../orange-lab/AGENTS.md`](../orange-lab/AGENTS.md)
- [`../orange-lab/.agents/skills/code-conventions/SKILL.md`](../orange-lab/.agents/skills/code-conventions/SKILL.md)
- [`../orange-lab/.agents/skills/document-app/SKILL.md`](../orange-lab/.agents/skills/document-app/SKILL.md)
- [`../orange-lab/.agents/skills/document-module/SKILL.md`](../orange-lab/.agents/skills/document-module/SKILL.md)
- [`../orange-lab/.agents/skills/resize-storage/SKILL.md`](../orange-lab/.agents/skills/resize-storage/SKILL.md)
- [`../orange-lab/.agents/skills/resource-tuning/SKILL.md`](../orange-lab/.agents/skills/resource-tuning/SKILL.md)
- [`../orange-lab/.agents/skills/code-review/SKILL.md`](../orange-lab/.agents/skills/code-review/SKILL.md)
