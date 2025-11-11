import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/** ----- Config ----- */
const FRONTEND_URL = process.env.FRONTEND_URL || "https://pi-dashboard-ui.vercel.app";
const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000"
].filter(Boolean);

/** ----- Middleware ----- */
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));
app.use(
  cors({
    origin: (origin, cb) => {
      // allow same-origin or tools like curl/postman (no origin)
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 86400
  })
);

// Quick preflight handling
app.options("*", (req, res) => res.sendStatus(204));

/** ----- Root redirect to UI ----- */
app.get("/", (_req, res) => {
  res.redirect(302, FRONTEND_URL);
});

/** ----- Health ----- */
app.get("/health", (_req, res) => res.sendStatus(200));

/** ----- OpenAPI + Swagger UI ----- */
const openapiPath = path.join(__dirname, "openapi.json");
let openapiDoc = {};
try {
  openapiDoc = JSON.parse(fs.readFileSync(openapiPath, "utf8"));
} catch (e) {
  // fallback if file missing
  openapiDoc = {
    openapi: "3.0.3",
    info: { title: "PI Dashboard API", version: "1.0.0" },
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          responses: { "200": { description: "OK" } }
        }
      }
    }
  };
}
app.get("/openapi.json", (_req, res) => res.json(openapiDoc));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiDoc, { explorer: true }));

/** ----- Example API namespace (placeholder) ----- */
const router = express.Router();
router.get("/hello", (_req, res) => res.json({ ok: true, message: "Hello from PI Dashboard API" }));
// TODO: add your real routes here (e.g., /jira/sprints, /jira/issues, etc.)
app.use("/api/v1", router);

/** ----- 404 handler ----- */
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

/** ----- Start ----- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
  console.log(`Docs: /docs`);
});
