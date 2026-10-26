import { CarFront, CircleHelp, Crosshair, MessageSquareText, Pencil } from "lucide-react";
import type { GameType } from "@spotflow-games/shared";

export function GameIcon({ type, size = 20 }: { type: GameType; size?: number }) {
  const props = { size, "aria-hidden": true, strokeWidth: 2.2 } as const;
  if (type === "draw") return <Pencil {...props} />;
  if (type === "truths") return <MessageSquareText {...props} />;
  if (type === "clash") return <Crosshair {...props} />;
  if (type === "race") return <CarFront {...props} />;
  return <CircleHelp {...props} />;
}
