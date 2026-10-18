# ADR 0013 — Keep native clock context independent of browser presence

Accepted 2026-10-18; pinned DSH 0.2.0-rc.2. Exact patch identity belongs to the seam registry.

MyAgents operations are not browser RPC messages. Native TimeContext correctly samples the process clock and timezone, but its missing browser-zone line unnecessarily demands user clarification. Public Config only controls display zone and refresh interval; post-processing text would violate its exact source snapshot and package invariant.

Patch 0013 omits the browser policy line when no request browser zone exists. Resolved and mixed browser zones retain their original policy. Native scheduling, clock, elapsed time, projection and source provenance stay unchanged. The invariant accepts absent policy only for missing browser context, and still validates historical unavailable lines, so existing Sessions restore without mutation or migration.

Tests cover host-neutral output, historical readings, and rejection of absent resolved/mixed policies. Remove the patch when upstream supplies equivalent semantics. No new option, owner, persistence or runtime protocol is introduced.
