# Dynamic E2E harness

This private, test-only workspace owns Batch 1 independent-Agent dynamic acceptance. It launches only an exact installed Runtime artifact, speaks through the generated Host client and `StandardTestHost`, gives the packed Root Agent natural scenario prompts, and seals black-box evidence before diagnostic facts become inspectable.

It is not a production dependency or Runtime extension. It does not register a tool, Provider, RPC method, event, AgentLoop, Session store, or alternate execution path. A missing approved Provider route or credential produces `unavailable`, never `passed`.

```bash
npm run e2e:dynamic -- --help
npm run e2e:dynamic -- list
npm run e2e:dynamic -- run --scenario coding-workspace --artifact /absolute/runtime-artifact
npm run e2e:dynamic -- campaign --artifact /absolute/runtime-artifact --jobs 1
npm run e2e:dynamic -- campaign --artifact /absolute/runtime-artifact \
  --route-config packages/dynamic-e2e/routes/deepseek-official-v4-flash.json \
  --compaction-route-config packages/dynamic-e2e/routes/deepseek-official-v4-flash-compaction.json \
  --credential-env DEEPSEEK_API_KEY --jobs 1
```

The sanctioned macOS production route is frozen in `routes/deepseek-official-v4-flash.json`; it contains no secret and declares the verified production capacity. Campaigns route only `compaction-continuity` through the separate 12,288-context / 2,048-output pressure profile, while every other scenario remains on the production profile. The Development Main Agent must explicitly supply both paths and the credential environment-variable name. Evidence is written beneath ignored `tmp/dynamic-e2e` by default; every retained file is sealed read-only and the verifier rejects unowned files, aliases, or index drift.

External Tester Agents follow [REPORTER_PROMPT.md](./REPORTER_PROMPT.md). Their reports are usability/risk evidence, not release authority.
