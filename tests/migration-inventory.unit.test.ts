import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { validateMigrationInventory } from "../scripts/verify-migration-inventory.js";

type InventoryFixture = {
  entries: Array<{
    id: string;
    matches: Record<string, string[]>;
    testFixtureDisposition?: string;
  }>;
};

type SnapshotFixture = {
  includedPaths: string[];
};

const repositoryRoot = resolve(import.meta.dirname, "..");
let inventoryFixture: InventoryFixture;
let snapshotFixture: SnapshotFixture;
let snapshotBytes: string;

beforeAll(async () => {
  const [inventoryBytes, loadedSnapshotBytes] = await Promise.all([
    readFile(
      resolve(repositoryRoot, "specs/migration/myagents-runtime-b7bbcadb.inventory.json"),
      "utf8",
    ),
    readFile(
      resolve(repositoryRoot, "specs/migration/myagents-runtime-b7bbcadb.source-tree.json"),
      "utf8",
    ),
  ]);
  inventoryFixture = JSON.parse(inventoryBytes) as InventoryFixture;
  snapshotFixture = JSON.parse(loadedSnapshotBytes) as SnapshotFixture;
  snapshotBytes = loadedSnapshotBytes;
});

const validate = (inventory: InventoryFixture, snapshot: SnapshotFixture, bytes = snapshotBytes) =>
  validateMigrationInventory({
    inventoryValue: inventory,
    snapshotValue: snapshot,
    snapshotBytes: bytes,
  }).failures;

describe("migration inventory fail-closed rules", () => {
  it("rejects an omitted fixed source root", () => {
    const snapshot = structuredClone(snapshotFixture);
    snapshot.includedPaths = snapshot.includedPaths.slice(1);
    const failures = validate(inventoryFixture, snapshot, `${JSON.stringify(snapshot, null, 2)}\n`);

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source snapshot byte digest"),
        "source snapshot includedPaths/order must match the fixed migration scope",
      ]),
    );
  });

  it("rejects an empty inventory match rule", () => {
    const inventory = structuredClone(inventoryFixture);
    const entry = inventory.entries.find(({ id }) => id === "runtime-server-entry");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    entry.matches = {};

    expect(validate(inventory, snapshotFixture)).toEqual(
      expect.arrayContaining([
        "runtime-server-entry matches contains no rules or unknown fields",
        "runtime-server-entry must declare at least one positive match rule",
        "runtime-server-entry must own at least one source path",
      ]),
    );
  });

  it("rejects a typo in an exact source path", () => {
    const inventory = structuredClone(inventoryFixture);
    const entry = inventory.entries.find(({ id }) => id === "workspace-clean-script");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    entry.matches.paths = ["scripts/clean.typo.mjs"];

    expect(validate(inventory, snapshotFixture)).toEqual(
      expect.arrayContaining([
        "workspace-clean-script exact match path does not exist in source snapshot: scripts/clean.typo.mjs",
        "workspace-clean-script must own at least one source path",
      ]),
    );
  });

  it("rejects invalid and missing test/fixture dispositions", () => {
    const invalidInventory = structuredClone(inventoryFixture);
    const invalidEntry = invalidInventory.entries.find(({ id }) => id === "product-scope-docs");
    expect(invalidEntry).toBeDefined();
    if (invalidEntry === undefined) return;
    invalidEntry.testFixtureDisposition = "copy-sometimes";
    expect(validate(invalidInventory, snapshotFixture)).toContain(
      "product-scope-docs has invalid testFixtureDisposition",
    );

    const missingInventory = structuredClone(inventoryFixture);
    const missingEntry = missingInventory.entries.find(({ id }) => id === "product-scope-docs");
    expect(missingEntry).toBeDefined();
    if (missingEntry === undefined) return;
    delete missingEntry.testFixtureDisposition;
    expect(validate(missingInventory, snapshotFixture)).toEqual(
      expect.arrayContaining([
        "product-scope-docs schema mismatch",
        "product-scope-docs has invalid testFixtureDisposition",
      ]),
    );
  });

  it("rejects none when an entry owns tests or fixtures", () => {
    const inventory = structuredClone(inventoryFixture);
    const entry = inventory.entries.find(({ id }) => id === "sdk-compatibility-baseline");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    entry.testFixtureDisposition = "none";

    expect(validate(inventory, snapshotFixture)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "sdk-compatibility-baseline declares no tests/fixtures but owns:",
        ),
      ]),
    );
  });

  it("rejects a non-none disposition when an entry owns no test or fixture", () => {
    const inventory = structuredClone(inventoryFixture);
    const entry = inventory.entries.find(({ id }) => id === "runtime-server-entry");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    entry.testFixtureDisposition = "migrate";

    expect(validate(inventory, snapshotFixture)).toContain(
      "runtime-server-entry declares migrate tests/fixtures but owns none",
    );
  });
});
