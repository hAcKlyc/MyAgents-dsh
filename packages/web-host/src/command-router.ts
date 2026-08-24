import type { MethodParams } from "@myagents-dsh/protocol";
import type { BrowserCommand } from "@myagents-dsh/web-host-contract";

import type {
  NativeBrowserCommand,
  NativeBrowserCommandContext,
  NativeBrowserCommandHandler,
} from "./application.js";
import { WebHostError } from "./errors.js";

type Command<Kind extends BrowserCommand["kind"]> = Extract<BrowserCommand, { kind: Kind }>;
type AdvancedCommand = Extract<NativeBrowserCommand,
  | { kind: "components.replace" }
  | { kind: "mutation.prepare" | "mutation.commit" | "mutation.rollback" | "mutation.status" | "mutation.purge" }
>;
export type SessionOperationAuthority = Readonly<{
  configRevision: string;
  extensionDigest: string;
  executionEnvironmentRevision: string;
  executionEnvironmentDigest: string;
  limits: MethodParams<"turn/start">["limits"];
  origin: MethodParams<"turn/start">["origin"];
  systemPrompt: string;
  modelProfileRevision: string;
}>;
export type BrowserCommandRouterOptions = Readonly<{
  authority: (context: NativeBrowserCommandContext) => SessionOperationAuthority;
  configApply: (
    command: Command<"config.apply">,
    context: NativeBrowserCommandContext,
  ) => MethodParams<"config/apply">;
  advanced: (command: AdvancedCommand, context: NativeBrowserCommandContext) => Promise<unknown>;
}>;
type ImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const isImageMimeType = (value: string): value is ImageMimeType =>
  value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp";

const input = (
  text: string,
  attachmentIds: readonly string[],
  context: NativeBrowserCommandContext,
): MethodParams<"turn/start">["input"] => {
  const attachments = attachmentIds.map((attachmentId) => {
    const attachment = context.attachments.find((candidate) => candidate.attachmentId === attachmentId);
    if (attachment === undefined || attachment.state === "failed" || attachment.state === "released") {
      throw new WebHostError("attachment_unknown", "Turn attachment is not available", true);
    }
    const mimeType = attachment.mimeType;
    if (!isImageMimeType(mimeType)) {
      throw new WebHostError("attachment_turn_type_unsupported", "Turn input supports image attachments only");
    }
    if (attachment.sizeBytes < 1 || attachment.sizeBytes > 5 * 1_024 * 1_024) {
      throw new WebHostError("attachment_turn_limit", "Turn image exceeds its Runtime byte limit");
    }
    return {
      kind: "image_ref" as const,
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mimeType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
    };
  });
  return { parts: [{ kind: "text", text }, ...attachments] };
};

export class BrowserNativeCommandRouter {
  readonly #options: BrowserCommandRouterOptions;

  constructor(options: BrowserCommandRouterOptions) { this.#options = options; }

  readonly handle: NativeBrowserCommandHandler = async (command, context) => {
    const authority = this.#options.authority(context);
    switch (command.kind) {
      case "history.read":
        return context.client.sessionRead(command.payload.cursor === undefined ? {} : { cursor: command.payload.cursor });
      case "session.compact":
        return context.client.sessionCompact({ clientOperationId: command.payload.clientOperationId });
      case "turn.start":
        return context.client.turnStart({
          clientOperationId: command.payload.clientOperationId,
          clientUserMessageId: command.payload.clientUserMessageId,
          input: input(command.payload.text, command.payload.attachmentIds, context),
          configRevision: authority.configRevision,
          extensionDigest: authority.extensionDigest,
          executionEnvironmentRevision: authority.executionEnvironmentRevision,
          executionEnvironmentDigest: authority.executionEnvironmentDigest,
          limits: authority.limits,
          origin: authority.origin,
        });
      case "turn.steer":
        return context.client.turnSteer({
          clientOperationId: command.payload.clientOperationId,
          input: input(command.payload.text, [], context),
        });
      case "turn.followUp":
        return context.client.turnFollowUp({
          clientOperationId: command.payload.clientOperationId,
          messageId: command.payload.messageId,
          input: input(command.payload.text, command.payload.attachmentIds, context),
        });
      case "turn.cancelQueued":
        return context.client.turnMessageCancel({
          clientOperationId: command.payload.clientOperationId,
          messageId: command.payload.messageId,
        });
      case "turn.interrupt":
        return context.client.turnInterrupt({
          clientOperationId: command.payload.clientOperationId,
          cancelQueued: command.payload.cancelQueued,
        });
      case "command.invoke":
        return context.client.commandInvoke({
          clientOperationId: command.payload.clientOperationId,
          clientUserMessageId: command.payload.clientUserMessageId,
          commandId: command.payload.commandId,
          arguments: command.payload.arguments,
          configRevision: authority.configRevision,
          extensionDigest: authority.extensionDigest,
          executionEnvironmentRevision: authority.executionEnvironmentRevision,
          executionEnvironmentDigest: authority.executionEnvironmentDigest,
          limits: authority.limits,
          origin: authority.origin,
        });
      case "config.apply":
        return context.client.configApply(this.#options.configApply(command, context));
      case "components.inspect":
        return context.client.extensionCatalog({});
      case "components.reload":
        return context.client.extensionReload({ clientOperationId: command.payload.clientOperationId });
      case "utility.run":
        return context.client.utilityRun({
          clientOperationId: command.payload.clientOperationId,
          prompt: command.payload.prompt,
          systemPrompt: authority.systemPrompt,
          modelProfileRevision: authority.modelProfileRevision,
          maxTokens: command.payload.maxTokens,
        });
      case "components.replace":
      case "mutation.prepare":
      case "mutation.commit":
      case "mutation.rollback":
      case "mutation.status":
      case "mutation.purge":
        return this.#options.advanced(command, context);
      default:
        throw new WebHostError("browser_command_unmapped", "Browser command has no explicit Runtime mapping");
    }
  };
}
