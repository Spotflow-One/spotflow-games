/** The app's logo lockup: the Spotflow mark, "Happy Hour", and a small "by Spotflow". */
export function Wordmark() {
  return (
    <>
      <img className="sg-logo" src="/spotflow-mark.png" alt="" width="24" height="22" />
      <span>
        Happy <em>Hour</em>
        <sub className="wordmark-by">by Spotflow</sub>
      </span>
    </>
  );
}
