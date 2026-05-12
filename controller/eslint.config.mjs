import { fixupConfigRules } from "@eslint/compat";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default fixupConfigRules([
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
  ...nextVitals,
  ...nextTs,
]);
