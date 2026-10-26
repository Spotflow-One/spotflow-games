import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/plugin.js";
import type { QuizSource } from "../games/quiz/library.js";

/** Quiz titles and sizes for the host setup screen. Questions and answers are never sent here. */
export function quizRoutes(app: FastifyInstance, deps: { quizSource: QuizSource }) {
  app.get("/api/quizzes", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return deps.quizSource.list();
  });
}
