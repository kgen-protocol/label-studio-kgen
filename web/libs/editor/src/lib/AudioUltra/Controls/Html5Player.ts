import type { WaveformAudio } from "../Media/WaveformAudio";
import { Player } from "./Player";
import { ff } from "@humansignal/core";

const RESET_RESUME_TIMEOUT_MS = 5000;
const PLAY_START_TIMEOUT_MS = 10000;

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

    // Guard every write to the underlying HTMLMediaElement.currentTime.
    // `this.currentTime` reads `this.time`, which can drift to NaN through
    // paths Player.ts can't intercept (e.g. the RAF watch() loop reading
    // back NaN from a peer that has been mid-flight when sync seek arrived
    // on a NaN duration). A bare write here throws synchronously inside the
    // MST sync action and unmounts the React tree.
    if (Number.isFinite(this.currentTime)) {
      this.audio.el.currentTime = this.currentTime;
    }
    this.audio.el.addEventListener("ended", this.handleEnded);
    this.bufferPromise = new Promise((resolve) => {
      this.bufferResolve = resolve;
    });

    const time = this.currentTime;

    // Bound the whole start-of-playback wait. `el.play()` and bufferPromise
    // (resolved by `canplaythrough`/`updateBuffering`) both depend on
    // network events that a genuinely degraded connection can simply never
    // fire — no error, nothing to catch, just silence. Without this, that
    // leaves `playing` stuck true (set optimistically in `playSource()`)
    // with no audio and no cursor movement, and no way for the user to
    // recover short of reloading. Time out and fall into the same cleanup
    // as a rejected `play()` instead.
    const startTimeout = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("Playback start timed out")), PLAY_START_TIMEOUT_MS);
    });

    Promise.race([Promise.all([this.audio.el.play(), this.bufferPromise]), startTimeout])
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
        // "AbortError: play() request was interrupted") without this ever
        // resolving. `playSource()` already set `this.playing = true`
        // optimistically before this call, so leaving it unhandled wedges
        // the player forever: `Player.play()`'s own guard blocks every
        // future call while `this.playing` stays stuck true, even though
        // nothing is actually playing.
        if (this.isDestroyed) return;

        this.audio?.el?.removeEventListener("ended", this.handleEnded);
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
