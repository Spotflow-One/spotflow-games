/**
 * Question banks for the curated quizzes. Each part is a block of lines in the form
 * "prompt | right answer | wrong | wrong | wrong", parsed by `parseBank` in ../library.ts.
 * A game draws 10 questions at random, so banks can grow freely.
 * Avoid facts that go stale, such as current office holders or records likely to fall.
 */
import africa1 from "./africa-1.js";
import africa2 from "./africa-2.js";
import africa3 from "./africa-3.js";
import africa4 from "./africa-4.js";
import africa5 from "./africa-5.js";
import general1 from "./general-1.js";
import general2 from "./general-2.js";
import general3 from "./general-3.js";
import general4 from "./general-4.js";
import general5 from "./general-5.js";
import money1 from "./money-1.js";
import money2 from "./money-2.js";
import money3 from "./money-3.js";
import money4 from "./money-4.js";
import money5 from "./money-5.js";
import money6 from "./money-6.js";
import tech1 from "./tech-1.js";
import tech2 from "./tech-2.js";
import tech3 from "./tech-3.js";
import tech4 from "./tech-4.js";
import tech5 from "./tech-5.js";
import tech6 from "./tech-6.js";

export const GENERAL = [general1, general2, general3, general4, general5].join("\n");
export const AFRICA = [africa1, africa2, africa3, africa4, africa5].join("\n");
export const MONEY = [money1, money2, money3, money4, money5, money6].join("\n");
export const TECH = [tech1, tech2, tech3, tech4, tech5, tech6].join("\n");
