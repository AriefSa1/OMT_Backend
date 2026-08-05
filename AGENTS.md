# Repository Guidelines

## Project Structure & Module Organization

This repository is a Node.js/Express backend for a Shopee marketplace and warehouse analytics service. The entry point is `server.js`, which loads configuration, registers API routes, initializes services, and starts cron jobs.

- `src/routes/`: Express routes grouped by feature, such as `authRoutes.js` and `syncRoutes.js`.
- `src/controllers/`: Request handlers for each route group.
- `src/services/`: Business logic, external API access, sync workflows, analytics, and AI integrations.
- `src/middleware/` and `src/utils/`: Shared auth, Prisma, cookie, and request helper utilities.
- `src/cron/`: Scheduled sync jobs.
- `prisma/schema.prisma`: SQLite-backed Prisma data model.
- `test_*.js` and `test-*.js`: Standalone verification scripts.

## Build, Test, and Development Commands

```bash
npm install
```

```bash
npm run dev
```

`npm start` runs the same command for production-style startup. The server defaults to `http://localhost:5000` unless `PORT` is set.

```bash
npm run prisma:generate
```

```bash
npm run prisma:db:push
```

## Coding Style & Naming Conventions

Use CommonJS modules (`require`, `module.exports`) and two-space indentation. Keep filenames feature-based: routes end in `Routes.js`, controllers in `Controller.js`, and services in `Service.js`. Use `camelCase` for variables and functions, `PascalCase` for classes or constructors, and uppercase names for static constants.

Prefer thin controllers that validate inputs and delegate business logic to `src/services/`. Keep database access through the existing Prisma helper instead of creating new clients.

## Testing Guidelines

There is no centralized npm test script yet. Run verification scripts directly with Node, for example:

```bash
node test_auth_m2.js
node test_e2e_verification.js
node test-ai-suite.js
```

Name new test scripts with the existing `test_*.js` or `test-*.js` pattern. Keep tests self-contained, use isolated ports for Express servers, and clean up Prisma records.

## Commit & Pull Request Guidelines

The current history uses short, plain-English commit messages such as `fix feature` and `Initial commit`. Continue with concise imperative messages, such as `add sync status endpoint`.

Pull requests should include a short summary, affected API areas, database or Prisma changes, and verification commands run. Include response examples when changing API output consumed by the frontend.

## Security & Configuration Tips

Keep secrets out of Git. `.env` and SQLite database files are ignored; use variables such as `DATABASE_URL`, `PORT`, and `JWT_SECRET` locally. Do not commit Shopee cookies, warehouse credentials, Gemini API keys, or database backups. When changing auth or sync behavior, verify both protected and unauthenticated routes.
