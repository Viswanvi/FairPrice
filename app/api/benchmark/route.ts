import { HttpError, route } from "@/lib/http";
import { loadBenchmark } from "@/lib/pricing/benchmark-data";

/** GET /api/benchmark — the precomputed formula-versus-AI comparison for five invented products. */
export const GET = route(async () => {
  const benchmark = loadBenchmark();
  if (!benchmark) throw new HttpError(404, "not_generated", "The benchmark hasn't been generated yet (npm run benchmark).");
  return Response.json(benchmark, { headers: { "Cache-Control": "public, max-age=300" } });
});
