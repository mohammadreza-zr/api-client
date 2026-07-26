/**
 * Real API integration test.
 *
 * 1. Start the server:  npx tsx playground/server.ts
 * 2. Run this script:   npx tsx playground/test-real.ts
 */
import { APIClient } from "../src/client";
import { MemoryTokenStorage } from "../src/storage/memory-storage";

const BASE = "http://localhost:3333";

// ── Helpers ──────────────────────────────────────────────
function log(label: string, data: unknown) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`✅ ${label}`);
  console.log(JSON.stringify(data, null, 2));
}

function fail(label: string, data: unknown) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`❌ ${label}`);
  console.log(JSON.stringify(data, null, 2));
}

function assert(condition: boolean, label: string) {
  if (!condition) {
    console.error(`\n💥 ASSERTION FAILED: ${label}`);
    process.exit(1);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log("🧪 Real API Integration Test\n");
  console.log("Make sure the server is running: npx tsx playground/server.ts\n");

  const storage = new MemoryTokenStorage();
  let refreshCount = 0;

  const api = new APIClient(
    {
      baseUrl: BASE,
      timeout: 5000,
      toast: { error: (msg) => console.log(`   [toast] ${msg}`) },
      onAuthFailure: () => {
        console.log("   [auth-failure] Would redirect to /login");
      },
    },
    storage,
    // Refresh handler
    async (refreshToken) => {
      refreshCount++;
      console.log(`   [refresh] Called (#${refreshCount}) with: ${refreshToken?.slice(0, 20)}...`);

      const res = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: refreshToken }),
      });

      if (!res.ok) {
        console.log("   [refresh] Failed!");
        return null;
      }

      const data = await res.json();
      await storage.setAccessToken(data.data.access);
      await storage.setRefreshToken(data.data.refresh);
      console.log("   [refresh] Success! New token stored.");
      return data.data.access;
    },
  );

  // ── Test 1: Login ──────────────────────────────────────
  console.log("\n📋 Test 1: Login");
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@test.com", password: "password123" }),
  });
  const loginData = await loginRes.json();
  assert(loginRes.ok, "Login should succeed");

  await storage.setAccessToken(loginData.data.access);
  await storage.setRefreshToken(loginData.data.refresh);
  log("Login", { user: loginData.data.user, tokenExpiry: "5s" });

  // ── Test 2: GET with valid token ───────────────────────
  console.log("\n📋 Test 2: GET /users (valid token)");
  const usersRes = await api.get("/users", { params: { page: 1 } });
  assert(usersRes.status === true, "Should succeed");
  assert(usersRes.data.length === 3, "Should have 3 users");
  log("GET /users", usersRes.data);

  // ── Test 3: GET with URL template ──────────────────────
  console.log("\n📋 Test 3: GET /users/{id}");
  const userRes = await api.get("/users/{id}", {
    addTemplateToUrl: { id: 1 },
  });
  assert(userRes.status === true, "Should succeed");
  assert(userRes.data.id === 1, "Should be user 1");
  log("GET /users/1", userRes.data);

  // ── Test 4: POST ───────────────────────────────────────
  console.log("\n📋 Test 4: POST /users");
  const createRes = await api.post("/users", {
    name: "Dave",
    email: "dave@test.com",
  });
  assert(createRes.status === true, "Should succeed");
  assert(createRes.statusCode === 201, "Should be 201");
  log("POST /users", createRes.data);

  // ── Test 5: Validation error ───────────────────────────
  console.log("\n📋 Test 5: POST /users (validation error)");
  const invalidRes = await api.post("/users", { name: "" }, {
    hideErrorMessage: true,
  });
  assert(invalidRes.status === false, "Should fail");
  assert(invalidRes.statusCode === 400, "Should be 400");
  assert(invalidRes.errors?.email?.length > 0, "Should have email error");
  log("Validation errors", invalidRes.errors);

  // ── Test 6: Wait for token to expire ───────────────────
  console.log("\n📋 Test 6: Waiting 6s for access token to expire...");
  await sleep(6000);
  console.log("   Token should be expired now.");

  // ── Test 7: Auto-refresh on 401 ────────────────────────
  console.log("\n📋 Test 7: GET /users (expired token → auto refresh)");
  const afterRefresh = await api.get("/users");
  assert(afterRefresh.status === true, "Should succeed after refresh");
  assert(refreshCount === 1, "Should have called refresh exactly once");
  log("After refresh", { users: afterRefresh.data.length, refreshCount });

  // ── Test 8: Concurrent 401s ────────────────────────────
  console.log("\n📋 Test 8: Waiting 6s for token to expire again...");
  await sleep(6000);

  console.log("   Firing 5 concurrent requests with expired token...");
  const beforeCount = refreshCount;

  const results = await Promise.all([
    api.get("/users"),
    api.get("/users", { params: { page: 1 } }),
    api.get("/users/{id}", { addTemplateToUrl: { id: 1 } }),
    api.get("/users/{id}", { addTemplateToUrl: { id: 2 } }),
    api.get("/users", { params: { search: "alice" } }),
  ]);

  const allOk = results.every((r) => r.status === true);
  assert(allOk, "All 5 requests should succeed");
  assert(
    refreshCount === beforeCount + 1,
    `Should have called refresh exactly once more (was ${beforeCount}, now ${refreshCount})`,
  );
  log("Concurrent 401s", {
    totalRequests: 5,
    allSucceeded: allOk,
    refreshCalls: refreshCount - beforeCount,
  });

  // ── Test 9: PUT ────────────────────────────────────────
  console.log("\n📋 Test 9: PUT /users/{id}");
  const putRes = await api.put("/users/{id}", { name: "Alice Updated" }, {
    addTemplateToUrl: { id: 1 },
  });
  assert(putRes.status === true, "PUT should succeed");
  log("PUT /users/1", putRes.data);

  // ── Test 10: PATCH ─────────────────────────────────────
  console.log("\n📋 Test 10: PATCH /users/{id}");
  const patchRes = await api.patch("/users/{id}", { email: "newalice@test.com" }, {
    addTemplateToUrl: { id: 1 },
  });
  assert(patchRes.status === true, "PATCH should succeed");
  log("PATCH /users/1", patchRes.data);

  // ── Test 11: DELETE ────────────────────────────────────
  console.log("\n📋 Test 11: DELETE /users/{id}");
  const delRes = await api.delete("/users/{id}", {
    addTemplateToUrl: { id: 4 },
  });
  assert(delRes.status === true, "DELETE should succeed");
  log("DELETE /users/4", delRes.data);

  // ── Test 12: 500 error ─────────────────────────────────
  console.log("\n📋 Test 12: GET /error (500)");
  const errRes = await api.get("/error", { hideErrorMessage: true });
  assert(errRes.status === false, "Should fail");
  assert(errRes.statusCode === 500, "Should be 500");
  log("500 Error", { message: errRes.message, statusCode: errRes.statusCode });

  // ── Test 13: throwError mode ───────────────────────────
  console.log("\n📋 Test 13: GET /error with throwError");
  try {
    await api.get("/error", { throwError: true, hideErrorMessage: true });
    assert(false, "Should have thrown");
  } catch (err: any) {
    log("throwError caught", { message: err.message });
  }

  // ── Test 14: beforeFunc / afterFunc ────────────────────
  console.log("\n📋 Test 14: beforeFunc + afterFunc");
  const transformRes = await api.get("/users", {
    afterFunc: (data: any) => data.map((u: any) => u.name.toUpperCase()),
  });
  assert(transformRes.status === true, "Should succeed");
  log("afterFunc (names uppercased)", transformRes.data);

  // ── Test 15: Query string with nested params ───────────
  console.log("\n📋 Test 15: Nested query params");
  const nestedRes = await api.get("/users", {
    params: { page: 1, limit: 2, search: "bob" },
    log: true,
  });
  assert(nestedRes.status === true, "Should succeed");
  log("Nested params", nestedRes.data);

  // ── Test 16: Bad refresh token → onAuthFailure ─────────
  console.log("\n📋 Test 16: Bad refresh token → auth failure");
  await sleep(6000); // expire access
  await storage.setRefreshToken("totally-invalid-token");

  const failRes = await api.get("/users");
  assert(failRes.status === false, "Should fail");
  assert(failRes.statusCode === 401, "Should be 401");
  log("Auth failure", { message: failRes.message, statusCode: failRes.statusCode });

  // ── Summary ────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log("🎉 ALL 16 TESTS PASSED!");
  console.log(`   Total refresh calls: ${refreshCount}`);
  console.log(`${"═".repeat(50)}\n`);
}

main().catch((err) => {
  console.error("\n💥 Test failed:", err);
  process.exit(1);
});