# Package ownership

The Pre-Batch workspace freezes package ownership before behavior is implemented. Packages remain private and expose only APIs whose owning action or Batch has supplied executable contracts and tests.

| Package | Owner |
| --- | --- |
| `protocol` | Canonical native RPC source, projections, and peer contracts |
| `test-host` | Public generated-client-only Standard Host material |
| `product-profile` | Locked official DSH/plugin composition and digest |
| `runtime-product` | Product coordination services over DSH public seams |
| `compatibility` | Versioned sanitized compatibility declarations |
| `component-runtime` | Declarative component preparation, atomic promotion, catalog, and generation retirement |
| `artifact-verifier` | Artifact identity, provenance, and forbidden-content audits |
