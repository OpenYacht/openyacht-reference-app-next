import "server-only";
import type { SlugRegistry } from "@/federation";
import builders from "@/protocol/registry/builders.json";
import categories from "@/protocol/registry/categories.json";

// The vendored registries, imported statically so they are part of the build:
// validating or serving a listing never depends on a third-party host (LS-13).
const builderSlugs = new Set(builders.builders.map((builder) => builder.slug));
const categorySlugs = new Set(categories.categories.map((category) => category.slug));

export const vendoredRegistry: SlugRegistry = {
  hasBuilder: (slug) => builderSlugs.has(slug),
  hasCategory: (slug) => categorySlugs.has(slug),
};

export const registryVersions = { builders: builders.version, categories: categories.version };
