# Package ownership

The Pre-Batch workspace freezes package ownership before behavior is implemented. Packages remain private and expose no API until their owning action or Batch supplies executable contracts and tests.

| Package | Owner |
| --- | --- |
| `protocol` | Canonical native RPC source, projections, and peer contracts |
| `test-host` | Public generated-client-only Standard Host material |
| `product-profile` | Locked official DSH/plugin composition and digest |
| `runtime-product` | Product coordination services over DSH public seams |
| `compatibility` | Versioned sanitized compatibility declarations |
| `artifact-verifier` | Artifact identity, provenance, and forbidden-content audits |
