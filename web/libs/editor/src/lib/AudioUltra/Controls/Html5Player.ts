import type { WaveformAudio } from "../Media/WaveformAudio";
import { Player } from "./Player";
import { ff } from "@humansignal/core";

const RESET_RESUME_TIMEOUT_MS = 5000;
const PLAY_START_TIMEOUT_MS = 500;
const MAX_PLAY_START_ATTEMPTS = 3;
const PLAY_RETRY_DELAY_MS = 500;

/**
 * Waits for a reloaded element to actually become playable again, instead of
 * assuming `load()` succeeded. Resolves `false` on error/timeout so the
 * caller doesn't try to resume playback against a still-broken source.
 */
function waitForCanPlay(el: HTMLMediaElement, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      el.removeEventListener("canplaythrough", onCanPlay);
      el.removeEventListener("error", onError);
      resolve(result);
    };
    const onCanPlay = () => finish(true);
    const onError = () => finish(false);
    const timeoutId = setTimeout(() => finish(false), timeoutMs);

    el.addEventListener("canplaythrough", onCanPlay);
    el.addEventListener("error", onError);
  });
}

export class Html5Player extends Player {
  mute() {
    super.mute();
    if (this.audio?.el) {
      this.audio.el.muted = true;
    }
  }

  unmute() {
    super.unmute();
    if (this.audio?.el) {
      this.audio.el.muted = false;
    }
  }

  /**
   * Get current playback speed
   */
  get rate() {
    if (this.audio?.el) {
      if (this.audio.el.playbackRate !== this._rate) {
        this.audio.el.playbackRate = this._rate; // restore the correct rate
      }
    }

    return this._rate;
  }

  /**
   * Set playback speed
   */
  set rate(value: number) {
    const rateChanged = this._rate !== value;

    this._rate = value;

    if (rateChanged) {
      if (this.audio?.el) {
        this.audio.el.playbackRate = value;
      }
      this.wf.invoke("rateChanged", [value]);
    }
  }

  init(audio: WaveformAudio) {
    super.init(audio);

    if (!this.audio || !this.audio.el) return;

    this.audio.on("resetSource", this.handleResetSource);

    this.audio.el.addEventListener("play", this.handlePlayed);
    this.audio.el.addEventListener("pause", this.handlePaused);
  }

  destroy() {
    super.destroy();

    if (this.audio?.el) {
      this.audio.el.removeEventListener("play", this.handlePlayed);
      this.audio.el.removeEventListener("pause", this.handlePaused);
    }
  }

  protected adjustVolume(): void {
    if (this.audio?.el) {
      this.audio.el.volume = this.volume;
    }
  }

  protected playAudio(_start?: number, _duration?: number): void {
    if (!this.audio || !this.audio.el) return;

    this.attemptPlayback(this.currentTime, 0);
  }

  /**
   * Attempts to start playback, and on a genuine stall (no error, no
   * canplaythrough — a real degraded connection can sit in this state
   * indefinitely) forces a fresh connection with `el.load()` and retries a
   * bounded number of times before giving up. Re-calling `play()` alone
   * does nothing for this case: the element is already trying on the same
   * stuck request, so nothing changes without abandoning it and starting
   * over.
   */
  private attemptPlayback(time: number, attempt: number) {
    if (!this.audio || !this.audio.el) return;

    const el = this.audio.el;

    // Guard every write to the underlying HTMLMediaElement.currentTime.
    // `this.currentTime` reads `this.time`, which can drift to NaN through
    // paths Player.ts can't intercept (e.g. the RAF watch() loop reading
    // back NaN from a peer that has been mid-flight when sync seek arrived
    // on a NaN duration). A bare write here throws synchronously inside the
    // MST sync action and unmounts the React tree.
    if (Number.isFinite(time)) {
      el.currentTime = time;
    }
    el.addEventListener("ended", this.handleEnded);
    this.bufferPromise = new Promise((resolve) => {
      this.bufferResolve = resolve;
    });

    // Bound the whole start-of-playback wait. `el.play()` and bufferPromise
    // (resolved by `canplaythrough`/`updateBuffering`) both depend on
    // network events that a genuinely degraded connection can simply never
    // fire — no error, nothing to catch, just silence. Without this, that
    // leaves `playing` stuck true (set optimistically in `playSource()`)
    // with no audio and no cursor movement, and no way for the user to
    // recover short of reloading.
    const startTimeout = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("Playback start timed out")), PLAY_START_TIMEOUT_MS);
    });

    Promise.race([Promise.all([el.play(), this.bufferPromise]), startTimeout])
      .then(() => {
        this.timestamp = performance.now();

        // We need to compensate for the time it took to load the buffer
        // otherwise the audio will be out of sync of the timer we use to
        // render updates
        if (this.audio?.el) {
          // This must not be notifying of this adjustment otherwise it can cause sync issues and near infinite loops
          this.setCurrentTime(time);
          if (Number.isFinite(this.currentTime)) {
            this.audio.el.currentTime = this.currentTime;
          }
          this.watch();
        }
      })
      .catch(() => {
        // `audio.el.play()` can reject (autoplay-gesture policy, or
        // "AbortError: play() request was interrupted"), or the timeout
        // above can fire on a silent stall.
        if (this.isDestroyed) return;

        el.removeEventListener("ended", this.handleEnded);

        if (attempt < MAX_PLAY_START_ATTEMPTS) {
          // Abandon the stuck request and start a new one — same recovery
          // shape as handleResetSource's network-error retry, just reached
          // from a timeout instead of an `error` event.
          el.load();
          setTimeout(
            () => this.attemptPlayback(time, attempt + 1),
            PLAY_RETRY_DELAY_MS * (attempt + 1),
          );
          return;
        }

        // Every retry failed — give up so the player isn't wedged forever.
        // `playSource()` already set `this.playing = true` optimistically
        // before this call, so leaving it unhandled would wedge the player:
        // `Player.play()`'s own guard blocks every future call while
        // `this.playing` stays stuck true, even though nothing is playing.
        this.stopWatch();
        this.playing = false;
        this.wf.invoke("pause");
      });
  }

  protected updateCurrentSourceTime(timeChanged: boolean) {
    // Same guard as playAudio — never write a non-finite value to the
    // underlying media element. Player.setCurrentTime already rejects NaN
    // for explicit callers; this catches any remaining indirect mutations
    // of `this.time` (e.g. via the watch loop) that bypass that guard.
    if (timeChanged && this.audio?.el && Number.isFinite(this.time)) {
      this.audio.el.currentTime = this.time;
    }
  }

  protected canPause() {
    return !!(this.audio?.el && !this.audio.el.paused && this.hasPlayed);
  }

  protected disconnectSource(): boolean {
    if (super.disconnectSource()) {
      this.audio?.el?.removeEventListener("ended", this.handleEnded);
      return true;
    }
    return false;
  }

  protected handleResetSource = async () => {
    if (!this.audio?.el) return;

    const wasPlaying = this.playing;

    this.stop();
    // We don't need to load the audio when the feature flag is active
    if (!ff.isActive(ff.FF_SYNCED_BUFFERING)) {
      const el = this.audio.el;

      el.load();

      if (wasPlaying) {
        // Confirm the reload actually worked before resuming. Calling
        // play() right after load() targets an element that just dropped
        // back to HAVE_NOTHING — it can't tell us whether the retry
        // succeeded, and doing it blindly is what left playback silently
        // dead after a failed retry instead of trying again.
        const recovered = await waitForCanPlay(el, RESET_RESUME_TIMEOUT_MS);

        if (!recovered || this.isDestroyed || !this.audio) return;
      }
    }

    if (wasPlaying) this.play();
  };
}
