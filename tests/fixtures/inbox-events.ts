import type { Inbox, InboxTarget } from "@deepseek-ai/dsh-agent";
import type { MessageId, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";

/** Synthetic event writer for operation-fold tests, not an Agent driver.
 * Real delivery, wakeup and driver claiming are exercised by the composition tests.
 */
export class FixtureInbox implements Inbox {
  constructor(private readonly session: Session, private readonly receipts: {
    claimed(message: UserMessage, turn: number): void;
    discarded(message: UserMessage): void;
    inserted(message: UserMessage): void;
  }) {}

  private pending(target: InboxTarget): UserMessage[] {
    const messages: UserMessage[] = [];
    for (const event of this.session.snapshotEvents()) {
      if (event.type === "agent/inbox/spliced" && event.data.target === target) {
        messages.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted);
      }
    }
    return messages;
  }

  get nextTurn(): readonly UserMessage[] { return this.pending("next-turn"); }
  get nextStep(): readonly UserMessage[] { return this.pending("next-step"); }
  get hasPending(): boolean { return this.nextTurn.length + this.nextStep.length !== 0; }
  append(target: InboxTarget, message: UserMessage): void { this.splice(target, this.pending(target).length, 0, [message]); }
  prepend(target: InboxTarget, message: UserMessage): void { this.splice(target, 0, 0, [message]); }
  clear(): void { this.splice("next-step", 0, this.nextStep.length, []); this.splice("next-turn", 0, this.nextTurn.length, []); }
  remove(id: MessageId): boolean { return this.replacePending(id, []); }
  replace(id: MessageId, message: UserMessage): boolean { return this.replacePending(id, [message]); }

  private replacePending(id: MessageId, messages: UserMessage[]): boolean {
    for (const target of ["next-step", "next-turn"] as const) {
      const index = this.pending(target).findIndex((message) => message.id === id);
      if (index !== -1) { this.splice(target, index, 1, messages); return true; }
    }
    return false;
  }

  splice(target: InboxTarget, start: number, count: number, inserted: UserMessage[]): UserMessage[] {
    const removed = this.write(target, start, count, inserted, true);
    for (const message of removed) this.receipts.discarded(message);
    for (const message of inserted) this.receipts.inserted(message);
    return removed;
  }

  claim(target: InboxTarget, turn: number): UserMessage[] {
    const messages = this.write("next-step", 0, this.nextStep.length, [], false);
    if (target === "next-turn" && this.nextTurn.length !== 0) messages.push(...this.write("next-turn", 0, 1, [], false));
    for (const message of messages) this.receipts.claimed(message, turn);
    return messages;
  }

  private write(target: InboxTarget, start: number, count: number, inserted: UserMessage[], cancel: boolean): UserMessage[] {
    const messages = this.pending(target);
    const removed = messages.splice(start, count, ...inserted);
    if (removed.length === 0 && inserted.length === 0) return [];
    const ids = [...messages, ...this.pending(target === "next-step" ? "next-turn" : "next-step")].map(({ id }) => id);
    if (new Set(ids).size !== ids.length) throw new Error("fixture message is already pending");
    this.session.append("agent/inbox/spliced", { target, start, inserted,
      ...(removed.length === 0 ? {} : { removedCount: removed.length }),
      ...(cancel && removed.length !== 0 ? { outcome: "canceled" } : {}),
    });
    return removed;
  }
}
