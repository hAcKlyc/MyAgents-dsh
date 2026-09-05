import { isDeepStrictEqual } from "node:util";

import {
  ProtocolError,
  validateAgentCollaborationConfig,
  type AgentCollaborationConfig,
  type ModelExecutionProfile,
} from "@myagents-dsh/protocol";

export interface ChildModelSelection {
  readonly profile: ModelExecutionProfile;
  readonly selection: "inherit" | "fixed" | "agent";
}

/** Host declarations are the model catalog. This read-only view has no credentials or execution loop. */
export class AgentCollaborationPolicy {
  readonly config: AgentCollaborationConfig;
  readonly profiles: readonly ModelExecutionProfile[];
  readonly #profilesByRevision = new Map<string, ModelExecutionProfile>();
  readonly #profilesByRoute = new Map<string, ModelExecutionProfile>();
  readonly #roles = new Map<string, string>();

  constructor(root: ModelExecutionProfile, value?: AgentCollaborationConfig) {
    this.config = validateAgentCollaborationConfig(value ?? {
      version: 1,
      maxDepth: 1,
      maxActiveChildren: 32,
      maxRetainedChildren: 256,
      messageDelivery: "realtime",
      modelPolicy: { mode: "inherit", roles: [] },
      modelProfiles: [],
    });
    if (this.config.maxActiveChildren > this.config.maxRetainedChildren) {
      throw new ProtocolError("collaboration_config_invalid", "Active child capacity exceeds retained child capacity");
    }
    const canonicalRoot = validateAgentCollaborationConfig({ ...this.config, modelProfiles: [root] }).modelProfiles[0];
    if (canonicalRoot === undefined) throw new ProtocolError("collaboration_config_invalid", "Root model profile is missing");
    for (const profile of [canonicalRoot, ...this.config.modelProfiles]) {
      const revisionMatch = this.#profilesByRevision.get(profile.revision);
      const route = this.#routeKey(profile.providerRouteId, profile.modelId);
      const routeMatch = this.#profilesByRoute.get(route);
      if (revisionMatch !== undefined || routeMatch !== undefined) {
        if (revisionMatch === routeMatch && isDeepStrictEqual(revisionMatch, profile)) continue;
        throw new ProtocolError("collaboration_config_invalid", "Authorized model revisions and Provider/model identities must be unambiguous");
      }
      this.#profilesByRevision.set(profile.revision, profile);
      this.#profilesByRoute.set(route, profile);
    }
    const { mode, profileRef, roles } = this.config.modelPolicy;
    if ((mode === "fixed") !== (profileRef !== undefined)) {
      throw new ProtocolError("collaboration_config_invalid", "Only a fixed model strategy requires profileRef");
    }
    if (profileRef !== undefined) this.requireProfile(profileRef);
    for (const entry of roles) {
      if (this.#roles.has(entry.role)) throw new ProtocolError("collaboration_config_invalid", "A role may have only one fixed model");
      this.requireProfile(entry.profileRef);
      this.#roles.set(entry.role, entry.profileRef);
    }
    this.profiles = Object.freeze([...this.#profilesByRevision.values()]);
    Object.freeze(this);
  }

  requireProfile(revision: string): ModelExecutionProfile {
    const profile = this.#profilesByRevision.get(revision);
    if (profile === undefined) throw new ProtocolError("child_model_unauthorized", "Model profile is absent from the Host-authorized set");
    return profile;
  }

  profileFor(provider: string, model: string): ModelExecutionProfile {
    const profile = this.#profilesByRoute.get(this.#routeKey(provider, model));
    if (profile === undefined) throw new ProtocolError("child_model_unauthorized", "Provider/model route is absent from the Host-authorized set");
    return profile;
  }

  select(
    parent: Readonly<{ provider: string; model: string }>,
    role: string,
    requested?: string,
    declaredProfileRef?: string,
  ): ChildModelSelection {
    const roleProfile = this.#roles.get(role);
    if (declaredProfileRef !== undefined && roleProfile !== undefined && declaredProfileRef !== roleProfile) {
      throw new ProtocolError("child_model_conflict", "Component and Host role model constraints disagree");
    }
    const fixed = declaredProfileRef ?? roleProfile ?? this.config.modelPolicy.profileRef;
    const selectedRequest = requested === undefined ? undefined : this.#resolveRequest(requested);
    if (fixed !== undefined) {
      const profile = this.requireProfile(fixed);
      if (selectedRequest !== undefined && selectedRequest !== profile) {
        throw new ProtocolError("child_model_conflict", "Requested model conflicts with the fixed child model");
      }
      return Object.freeze({ profile, selection: "fixed" });
    }
    const inherited = this.profileFor(parent.provider, parent.model);
    if (selectedRequest !== undefined && this.config.modelPolicy.mode === "agent") {
      return Object.freeze({ profile: selectedRequest, selection: "agent" });
    }
    if (selectedRequest !== undefined && selectedRequest !== inherited) {
      throw new ProtocolError("child_model_selection_disabled", "Host has not enabled autonomous child model selection");
    }
    return Object.freeze({ profile: inherited, selection: "inherit" });
  }

  #resolveRequest(requested: string): ModelExecutionProfile {
    const exact = this.#profilesByRevision.get(requested);
    if (exact !== undefined) return exact;
    const matches = this.profiles.filter((profile) => profile.modelId === requested);
    if (matches.length === 1 && matches[0] !== undefined) return matches[0];
    throw new ProtocolError("child_model_unauthorized", "Use an authorized profile revision; the model name is absent or ambiguous");
  }

  #routeKey(provider: string, model: string): string { return JSON.stringify([provider, model]); }
}
