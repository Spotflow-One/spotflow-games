import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/plugin.js";
import type { WordSource } from "../games/draw/words.js";
import type { QuizSource } from "../games/quiz/library.js";

/**
 * Content pickers for the host setup screen. Only titles and sizes are sent:
 * quiz answers and secret words never leave the server here.
 */
export function contentRoutes(app: FastifyInstance, deps: { quizSource: QuizSource; wordSource: WordSource }) {
  app.get("/api/quizzes", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return deps.quizSource.list();
  });

  app.get("/api/word-lists", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return deps.wordSource.list();
  });
}
