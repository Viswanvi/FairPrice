import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { benchmarkFileSchema, type BenchmarkFile } from "./benchmark";

/**
 * The precomputed benchmark (data/benchmark-results.json, written by `npm run benchmark` and
 * committed), so the demo never waits on the AI. Returns null if it hasn't been generated.
 */
export function loadBenchmark(): BenchmarkFile | null {
  const file = path.join(process.cwd(), "data", "benchmark-results.json");
  if (!existsSync(file)) return null;
  return benchmarkFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
