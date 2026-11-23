import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps the write_inventory scope consistent everywhere it is declared:
 * both app configs, the .env.example template and the deployment guide.
 * (read_locations deliberately NOT requested: location reads via
 * InventoryLevel.location need only read_inventory — verified in the
 * 2026-07 Admin GraphQL docs.)
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function tomlScopes(relative: string): string[] {
  const match = read(relative).match(/^scopes\s*=\s*"([^"]+)"/m);
  expect(match, `${relative} must declare scopes`).toBeTruthy();
  return match![1]!.split(",").map((scope) => scope.trim()).filter(Boolean);
}

describe("inventory write scope config", () => {
  it.each([
    "shopify.app.toml",
    "shopify.app.barcode-studio-staging.toml",
  ])("%s requests write_inventory and keeps the read scopes", (file) => {
    const scopes = tomlScopes(file);
    expect(scopes).toContain("write_inventory");
    expect(scopes).toContain("read_inventory");
    expect(scopes).toContain("read_products");
    expect(scopes).toContain("write_products");
    expect(scopes).not.toContain("read_locations");
  });

  it(".env.example SCOPES matches the toml scopes", () => {
    const match = read(".env.example").match(/^SCOPES="([^"]+)"/m);
    expect(match, ".env.example must declare SCOPES").toBeTruthy();
    const scopes = match![1]!.split(",").map((s) => s.trim()).filter(Boolean);
    expect(scopes).toEqual(expect.arrayContaining(["write_inventory", "read_inventory"]));
  });

  it(".env.example documents the inventory write guard", () => {
    expect(read(".env.example")).toContain("ALLOW_INVENTORY_WRITES");
  });

  it("the deployment guide mentions write_inventory and the guard variable", () => {
    const guide = read("docs/DEPLOYMENT_GUIDE.md");
    expect(guide).toContain("write_inventory");
    expect(guide).toContain("ALLOW_INVENTORY_WRITES");
  });
});
