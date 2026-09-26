# Development setup and local MyAgents integration

This is the maintained entry for a clean checkout that will modify MyAgents-dsh and test the resulting native Runtime inside a MyAgents Dev build. The [verification and handoff guide](./verification-artifacts-and-handoff.md) owns release evidence and exact artifact contracts. `package.json`, the source authority manifests, and the builders own executable versions and parameters.

## Prepare a machine

Use Node `24.20.0` and npm `11.19.0` for the full setup and Runtime builder. `.nvmrc` records the minimum ordinary development Node, `24.15.0`; ordinary source tests admit Node `>=24.15.0 <25`, but this setup builds an artifact and requires the exact build version. Git, Corepack, and platform-native build tools must be available. On Windows, check out the repository with Git symlink support so `.claude/skills` is a link to `.agents/skills`.

```bash
./setup.sh
```

On Windows PowerShell, run `./setup.ps1`. Both call `scripts/setup.mjs` through npm so that npm/Corepack subprocesses use the selected Node toolchain. It runs `npm ci`, obtains the exact DSH and pi-ai source commits recorded in `specs/dsh/seam-decisions-v1.json` and `specs/pi-ai/seam-evidence-v1.json`, primes the package stores, builds or verifies the accepted patched DSH artifact, and installs those verified packages for repository checks. Its inputs and artifact live under ignored `tmp/setup/`; rerunning setup verifies and reuses the accepted artifact. Use `--dsh-source` / `--pi-ai-source` with absolute paths when those Git checkouts already exist. CI uses `--checks-only` to omit pi-ai preparation when it will only typecheck, lint, test, and build source. These standalone script entries leave `package.json`, an artifact identity input, unchanged.

`npm run build` builds source and Reference Web. It does not produce a MyAgents integration handoff. `npm ci` alone also leaves ordinary registry DSH packages in place and is not the completed checked setup.

## Modify DSH and build a local native handoff

After implementation and applicable checks, commit the DSH change. The handoff builder requires a clean checkout and binds the Runtime to that exact HEAD. Do not reuse an artifact or native report from an earlier source commit. Set `DSH_RELEASE_PROVIDER_KEY` in the current process environment for the credentialed native campaign; the value must not be written into this repository or printed. Choose a new absolute output directory outside this repository:

```bash
npm exec -- node scripts/build-local-handoff.mjs --out /absolute/path/to/new-local-work
```

On Windows PowerShell, use `npm.cmd exec -- node scripts/build-local-handoff.mjs --out C:\absolute\path\to\new-local-work`.

If setup used existing DSH or pi-ai repositories through `--dsh-source` or `--pi-ai-source`, pass those same absolute paths to this command. Otherwise it uses setup's sources under `tmp/setup/sources/`.

The command reuses setup's verified patched DSH artifact, runs source/pre-artifact checks, builds the Runtime, runs the current platform's native campaign, and generates `/absolute/path/to/new-local-work/handoff`. Its JSON result includes the handoff path, SHA-256, native target, and source commit. It does not create or push a tag or GitHub Release. A local native handoff requires a passing credentialed campaign; without that evidence it must not claim `verified`.

## Package MyAgents with those exact bytes

In the MyAgents repository, use the matching platform's Dev build entry with the **absolute handoff directory** from the previous command:

| Platform | Dev build entry |
| --- | --- |
| macOS | `./build_dev.sh --dsh-source local --dsh-handoff /absolute/path/to/new-local-work/handoff` |
| Linux x64 | `./build_dev_linux.sh --dsh-source local --dsh-handoff /absolute/path/to/new-local-work/handoff` |
| Windows x64 | `./build_dev_win.ps1 -DshSource local -DshHandoff C:\absolute\path\to\new-local-work\handoff` |

MyAgents verifies and stages the supplied handoff for this Dev build; it does not edit its committed DSH Release version selection. Formal MyAgents builds select the version in `src/shared/integrated-runtimes/dsh-release.json` and download that version's GitHub Release manifest and target archive. A new official DSH Release is a separate merge/tag/CI workflow documented in `.agents/skills/merge-release/SKILL.md`.
