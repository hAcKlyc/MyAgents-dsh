import type { TSchema } from "typebox";

/** Project the canonical JSON schemas into dependency-free, readonly TypeScript. */
export class ProtocolTypeProjector {
  private readonly declarations: string[] = [];
  private nextDefinition = 0;

  render(schema: TSchema, inherited = new Map<string, string>()): string {
    const value = schema as Record<string, unknown>;
    const definitions = value.$defs as Record<string, TSchema> | undefined;
    const names = new Map(inherited);
    if (definitions !== undefined) {
      for (const key of Object.keys(definitions)) names.set(key, `ProtocolDefinition${this.nextDefinition++}`);
      for (const [key, child] of Object.entries(definitions)) {
        const name = names.get(key);
        if (name === undefined) throw new Error("Protocol definition was not registered");
        this.declarations.push(`type ${name} = ${this.render(child, names)};`);
      }
    }
    if (typeof value.$ref === "string") {
      const name = names.get(value.$ref);
      if (name === undefined) throw new Error(`Unresolved public protocol type: ${value.$ref}`);
      return name;
    }
    if (Object.hasOwn(value, "const")) return JSON.stringify(value.const);
    if (Array.isArray(value.anyOf)) {
      const children = value.anyOf as (TSchema & Record<string, unknown>)[];
      // JSON Schema string unions often retain a named wildcard for validation prose.
      // Its TypeScript projection is already covered by the general string member.
      const hasString = children.some(child => child.type === "string" && !Object.hasOwn(child, "const"));
      return children.filter(child => !(hasString && typeof child.const === "string"))
        .map(child => `(${this.render(child, names)})`).join(" | ");
    }
    if (Array.isArray(value.allOf)) return value.allOf.map(child => `(${this.render(child as TSchema, names)})`).join(" & ");
    if (value.type === "string" || value.type === "boolean" || value.type === "null") return value.type;
    if (value.type === "number" || value.type === "integer") return "number";
    if (value.type === "array") {
      if (Array.isArray(value.items)) return `readonly [${value.items.map(child => this.render(child as TSchema, names)).join(", ")}]`;
      return `ReadonlyArray<${value.items === undefined ? "unknown" : this.render(value.items as TSchema, names)}>`;
    }
    if (value.type === "object") {
      const required = new Set(value.required as string[] | undefined);
      const properties = Object.entries(value.properties as Record<string, TSchema> | undefined ?? {})
        .map(([key, child]) => `readonly ${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${this.render(child, names)};`);
      const patterns = Object.values(value.patternProperties as Record<string, TSchema> | undefined ?? {});
      const dictionary = patterns.length > 0
        ? `Readonly<Record<string, ${patterns.map(child => this.render(child, names)).join(" | ")}>>`
        : value.additionalProperties !== false
          ? `Readonly<Record<string, ${typeof value.additionalProperties === "object" ? this.render(value.additionalProperties as TSchema, names) : "unknown"}>>`
          : undefined;
      if (properties.length === 0) return dictionary ?? "Readonly<Record<string, never>>";
      const object = `{ ${properties.join(" ")} }`;
      return dictionary === undefined ? object : `(${object} & ${dictionary})`;
    }
    if (Object.keys(value).length === 0) return "unknown";
    throw new Error(`Unsupported public protocol schema: ${JSON.stringify(value)}`);
  }

  definitions(): string { return this.declarations.join("\n"); }
}
