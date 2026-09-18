import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    // The one structural rule of this repository: the federation core is
    // framework-free. It may import node: built-ins and its own files only.
    files: ["federation/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["next", "next/*", "react", "react-dom", "server-only"], message: "federation/ must not depend on Next.js or React." },
            {
              group: ["@supabase/*", "pg"],
              message: "federation/ must not depend on Supabase or a database client; use the interfaces in ports.ts.",
            },
            { group: ["@/lib/*", "@/app/*", "../lib/*", "../app/*"], message: "federation/ must not import from the host application." },
          ],
        },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "federation/generated/**", "protocol/**"]),
]);

export default eslintConfig;
