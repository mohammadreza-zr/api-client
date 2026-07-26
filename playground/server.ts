import express from "express";
import jwt from "jsonwebtoken";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const ACCESS_SECRET = "access-secret-key";
const REFRESH_SECRET = "refresh-secret-key";

// Access token expires in 5 seconds (so you can test refresh easily)
const ACCESS_EXPIRY = "5s";
const REFRESH_EXPIRY = "7d";

// ── In-memory user store ─────────────────────────────────
const users = [
  { id: 1, name: "Alice", email: "alice@test.com" },
  { id: 2, name: "Bob", email: "bob@test.com" },
  { id: 3, name: "Charlie", email: "charlie@test.com" },
];

let refreshCallCount = 0;

// ── Helpers ──────────────────────────────────────────────
function generateTokens(userId: number) {
  const access = jwt.sign({ sub: userId, type: "access" }, ACCESS_SECRET, {
    expiresIn: ACCESS_EXPIRY,
  });
  const refresh = jwt.sign({ sub: userId, type: "refresh" }, REFRESH_SECRET, {
    expiresIn: REFRESH_EXPIRY,
  });
  return { access, refresh };
}

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const header = req.headers.authorization ?? "";
  const token = header.replace("Bearer ", "");

  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }

  try {
    const payload = jwt.verify(token, ACCESS_SECRET) as { sub: number };
    (req as any).userId = payload.sub;
    next();
  } catch (err: any) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }
    return res.status(401).json({ message: "Invalid token" });
  }
}

// ── Routes ───────────────────────────────────────────────

// Login
app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;

  if (email === "alice@test.com" && password === "password123") {
    const tokens = generateTokens(1);
    console.log("[server] Login successful. Access token expires in 5s.");
    return res.json({
      data: { user: users[0], ...tokens },
      message: "Login successful",
    });
  }

  res.status(401).json({ message: "Invalid credentials" });
});

// Refresh
app.post("/auth/refresh", (req, res) => {
  refreshCallCount++;
  console.log(`[server] Refresh called (count: ${refreshCallCount})`);

  const { refresh } = req.body;

  if (!refresh) {
    return res.status(400).json({ message: "Refresh token required" });
  }

  try {
    const payload = jwt.verify(refresh, REFRESH_SECRET) as { sub: number };
    const tokens = generateTokens(payload.sub);
    console.log("[server] New tokens issued.");
    return res.json({
      data: tokens,
      message: "Refreshed",
    });
  } catch {
    return res.status(401).json({ message: "Invalid refresh token" });
  }
});

// Logout
app.post("/auth/logout", authMiddleware, (req, res) => {
  console.log("[server] User logged out.");
  res.json({ message: "Logged out" });
});

// GET /users (protected)
app.get("/users", authMiddleware, (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;
  const search = (req.query.search as string) || "";

  let filtered = users;
  if (search) {
    filtered = users.filter((u) =>
      u.name.toLowerCase().includes(search.toLowerCase()),
    );
  }

  console.log(`[server] GET /users?page=${page}&search=${search}`);
  res.json({
    data: filtered,
    message: "OK",
    meta: { page, limit, total: filtered.length },
  });
});

// GET /users/:id (protected)
app.get("/users/:id", authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  const user = users.find((u) => u.id === id);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  res.json({ data: user, message: "OK" });
});

// POST /users (protected)
app.post("/users", authMiddleware, (req, res) => {
  const { name, email } = req.body;

  const errors: Record<string, string[]> = {};
  if (!name) errors.name = ["This field is required."];
  if (!email) errors.email = ["This field is required."];

  if (Object.keys(errors).length) {
    return res.status(400).json({ message: "Validation failed", errors });
  }

  const newUser = { id: users.length + 1, name, email };
  users.push(newUser);

  console.log(`[server] Created user: ${name}`);
  res.status(201).json({ data: newUser, message: "Created" });
});

// PUT /users/:id (protected)
app.put("/users/:id", authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return res.status(404).json({ message: "Not found" });

  users[idx] = { ...users[idx], ...req.body, id };
  res.json({ data: users[idx], message: "Updated" });
});

// PATCH /users/:id (protected)
app.patch("/users/:id", authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return res.status(404).json({ message: "Not found" });

  users[idx] = { ...users[idx], ...req.body, id };
  res.json({ data: users[idx], message: "Patched" });
});

// DELETE /users/:id (protected)
app.delete("/users/:id", authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return res.status(404).json({ message: "Not found" });

  users.splice(idx, 1);
  res.json({ data: { id }, message: "Deleted" });
});

// Slow endpoint (for timeout testing)
app.get("/slow", authMiddleware, async (req, res) => {
  await new Promise((r) => setTimeout(r, 10_000));
  res.json({ data: "slow" });
});

// Server error
app.get("/error", (req, res) => {
  res.status(500).json({ message: "Internal Server Error" });
});

// Stats
app.get("/stats", (req, res) => {
  res.json({ refreshCallCount });
});

// ── Start ────────────────────────────────────────────────
const PORT = 3333;
app.listen(PORT, () => {
  console.log(`\n🚀 Real API server running at http://localhost:${PORT}`);
  console.log(`   Access token expiry: ${ACCESS_EXPIRY}`);
  console.log(`   Refresh token expiry: ${REFRESH_EXPIRY}`);
  console.log(`\n   Login: POST /auth/login { email: "alice@test.com", password: "password123" }`);
  console.log(`   Refresh: POST /auth/refresh { refresh: "..." }`);
  console.log(`   Protected: GET /users (Authorization: Bearer <token>)\n`);
});