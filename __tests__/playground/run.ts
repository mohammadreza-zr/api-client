/**
 * Manual playground.
 * Run: npx tsx __tests__/playground/run.ts
 *
 * Requires: npm install --save-dev tsx
 */
import { APIClient } from "../../src/client";
import { MemoryTokenStorage } from "../../src/storage/memory-storage";

async function main() {
  console.log("=== API Client Playground ===\n");

  const storage = new MemoryTokenStorage();
  await storage.setAccessToken("my-access-token");
  await storage.setRefreshToken("my-refresh-token");

  const api = new APIClient(
    {
      baseUrl: "https://jsonplaceholder.typicode.com",
      timeout: 10_000,
    },
    storage,
    async (refreshToken) => {
      console.log("[refresh] Called with:", refreshToken);
      // Simulate refresh
      return "new-access-token-" + Date.now();
    },
    () => {
      console.log("[auth-failure] Redirecting to login...");
    },
  );

  // ── GET ──
  console.log("1. GET /todos/1");
  const todo = await api.get("/todos/1", { log: true });
  console.log("   Status:", todo.statusCode, "| Title:", (todo.data as any)?.title);

  // ── GET with params ──
  console.log("\n2. GET /posts with params");
  const posts = await api.get("/posts", {
    params: { _limit: 3, userId: 1 },
  });
  console.log("   Count:", (posts.data as any[])?.length);

  // ── POST ──
  console.log("\n3. POST /posts");
  const created = await api.post("/posts", {
    title: "Hello",
    body: "World",
    userId: 1,
  });
  console.log("   Created ID:", (created.data as any)?.id);

  // ── URL Template ──
  console.log("\n4. GET /posts/{id}");
  const post = await api.get("/posts/{id}", {
    addTemplateToUrl: { id: 5 },
  });
  console.log("   Title:", (post.data as any)?.title);

  // ── Error ──
  console.log("\n5. GET /nonexistent (404)");
  const notFound = await api.get("/nonexistent", {
    hideErrorMessage: true,
  });
  console.log("   Status:", notFound.statusCode, "| Message:", notFound.message);

  console.log("\n=== Done ===");
}

main().catch(console.error);