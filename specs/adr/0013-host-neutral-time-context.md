# ADR 0013 — Keep native clock context independent of browser presence

Accepted 2026-10-18; rebased to DSH 0.2.1-rc.2 on 2026-10-23. Exact patch identity belongs to the seam registry.

MyAgents operations are not browser RPC messages. Native TimeContext correctly samples the process clock and timezone, but its missing browser-zone line unnecessarily demands user clarification. Public Config only controls display zone and refresh interval; post-processing text would violate its exact source snapshot and package invariant.

Patch 0013 omits the browser policy line when no request browser zone exists. Resolved and mixed browser zones retain their original policy. Native scheduling, clock, elapsed time, projection and source provenance stay unchanged. The native time projection reads historical unavailable lines without mutation or migration. The candidate removed the separate invariant framework; this patch retains only the renderer change and tests native cold replay plus resolved/mixed rendering instead of restoring that framework.

Tests cover host-neutral output, historical readings, and rejection of absent resolved/mixed policies. Remove the patch when upstream supplies equivalent semantics. No new option, owner, persistence or runtime protocol is introduced.
