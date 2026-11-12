import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const VARIANT_METAFIELD_DEFINITIONS = [
  {
    key: "pacific_smoke_sku",
    name: "Pacific Smoke SKU",
    description: "Pacific Smoke SKU assigned by Barcode Studio",
  },
  {
    key: "valor_sku",
    name: "Valor SKU",
    description: "Valor SKU assigned by Barcode Studio",
  },
] as const;

/**
 * Creates the app-owned PRODUCTVARIANT metafield definitions ($app namespace,
 * single_line_text_field) via the Admin GraphQL API.
 *
 * The declarative [product_variant.metafields.app.*] toml sections aren't
 * supported by the installed Shopify CLI version, so we do it here instead.
 * Idempotent: "already exists"/taken errors are ignored.
 */
export async function ensureVariantMetafieldDefinitions(
  admin: AdminApiContext,
) {
  for (const definition of VARIANT_METAFIELD_DEFINITIONS) {
    const response = await admin.graphql(
      `#graphql
      mutation CreateVariantMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            id
            namespace
            key
          }
          userErrors {
            field
            message
            code
          }
        }
      }`,
      {
        variables: {
          definition: {
            namespace: "$app",
            key: definition.key,
            name: definition.name,
            description: definition.description,
            type: "single_line_text_field",
            ownerType: "PRODUCTVARIANT",
            access: {
              admin: "MERCHANT_READ_WRITE",
            },
          },
        },
      },
    );

    // Typed locally (rather than via generated AdminOperations) because
    // `npm run typecheck` does not run graphql-codegen.
    const responseJson = (await response.json()) as {
      data?: {
        metafieldDefinitionCreate?: {
          createdDefinition?: { id: string; namespace?: string; key?: string };
          userErrors?: Array<{ field?: string[]; message?: string; code?: string }>;
        };
      };
      errors?: unknown;
    };
    const result = responseJson.data?.metafieldDefinitionCreate;

    if (!result) {
      console.error(
        `metafieldDefinitionCreate (${definition.key}): no data in response`,
        JSON.stringify(responseJson),
      );
      continue;
    }

    const blockingErrors = (result.userErrors ?? []).filter(
      (error) =>
        !error.message?.toLowerCase().includes("already exists") &&
        !error.message?.toLowerCase().includes("already been taken"),
    );

    if (blockingErrors.length > 0) {
      console.error(
        `metafieldDefinitionCreate (${definition.key}) errors:`,
        JSON.stringify(blockingErrors),
      );
    }
  }
}
