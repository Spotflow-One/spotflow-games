import { useEffect } from "react";
import { MusicPlayer, type TrackName } from "./musicEngine";
import { usePreferences } from "./preferences";

const player = new MusicPlayer(0.15);

/** Plays a looping track while the component is shown and sound is on. Null plays nothing. */
export function useMusic(track: TrackName | null) {
  const { soundEnabled } = usePreferences();
  useEffect(() => {
    if (!soundEnabled || !track) return;
    player.play(track);
    return () => player.stop(track);
  }, [track, soundEnabled]);
}
