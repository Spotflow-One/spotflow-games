import { randomInt } from "node:crypto";
import { SESSION_CODE_ALPHABET, SESSION_CODE_LENGTH } from "@spotflow-games/shared";

export function generateSessionCode(): string {
  let code = "";
  for (let i = 0; i < SESSION_CODE_LENGTH; i++) {
    code += SESSION_CODE_ALPHABET[randomInt(SESSION_CODE_ALPHABET.length)];
  }
  return code;
}
