import { defineConfig } from "vitest/config";

// Desktop has no browser runtime; its tests are pure-logic unit tests. Scope
// the test runner to src/ only so generated/packaged trees under the project
// dir (e.g. .runtime-bundle/, which mirrors core's src/ and shares the "src"
// path segment that vitest's CLI filter matches against) are never collected.
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["node_modules/**", "dist/**", ".runtime-bundle/**", "release/**"]
  }
});
