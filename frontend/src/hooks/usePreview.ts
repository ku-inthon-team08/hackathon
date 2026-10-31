import { useCallback, useEffect, useRef, useState } from "react";

const MAX_SECONDS = 8;

// Sensory preview: quiet filtered noise built from noise_grade. Only ever starts from a
// tap, stays at a low volume whatever the grade, and stops on its own.
export function usePreview() {
  const [playing, setPlaying] = useState(false);
  const context = useRef<AudioContext | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const stop = useCallback(() => {
    window.clearTimeout(timer.current);
    context.current?.close();
    context.current = null;
    setPlaying(false);
  }, []);

  const start = useCallback(
    (grade: number) => {
      const audio = new AudioContext();
      const buffer = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
      const samples = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < samples.length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        samples[i] = last * 3.5;
      }
      const noise = audio.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;
      const filter = audio.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 200 + grade * 300;
      const gain = audio.createGain();
      gain.gain.setValueAtTime(0, audio.currentTime);
      gain.gain.linearRampToValueAtTime(0.03 + grade * 0.02, audio.currentTime + 1);
      noise.connect(filter).connect(gain).connect(audio.destination);
      noise.start();
      context.current = audio;
      setPlaying(true);
      timer.current = window.setTimeout(stop, MAX_SECONDS * 1000);
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return { playing, start, stop };
}
