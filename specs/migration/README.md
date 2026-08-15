# Source migration inventory

This directory freezes the source-level migration map from the implemented Pi Runtime into MyAgents-dsh. It contains no copied implementation, prompts, transcripts, credentials, user files, or fixture contents.

The two authorities are:

- `myagents-runtime-b7bbcadb.source-tree.json`: a deterministic path/blob-identity snapshot generated from the exact committed source baseline;
- `myagents-runtime-b7bbcadb.inventory.json`: reviewed per-capability ownership, reuse classification, DSH seam, Pi-removal notes, provenance, and required evidence.

Run `npm run check:migration` without access to the sibling repository. Maintainers with the exact source checkout may additionally regenerate the identity snapshot:

```bash
npm run snapshot:migration-source -- ../myagents-runtime
git diff --exit-code -- specs/migration/myagents-runtime-b7bbcadb.source-tree.json
```

Or use the non-writing drift gate directly:

```bash
npm run snapshot:migration-source -- --check ../myagents-runtime
```

The snapshot records Git object IDs, not source contents. Copying or adapting any implementation remains a later reviewed action under the inventory decision and repository security policy.
