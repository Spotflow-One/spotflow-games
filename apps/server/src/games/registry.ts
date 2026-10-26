import type { GameType } from "@spotflow-games/shared";
import type { AnyGameEngine } from "./contract.js";

/** Game engines are added here as they are built (milestone 2). */
export class GameRegistry {
  private engines = new Map<GameType, AnyGameEngine>();

  register(engine: AnyGameEngine) {
    this.engines.set(engine.type, engine);
    return this;
  }

  get(type: GameType): AnyGameEngine | undefined {
    return this.engines.get(type);
  }

  available(): GameType[] {
    return [...this.engines.keys()];
  }
}
