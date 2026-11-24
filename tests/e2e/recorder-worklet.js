// Tests only: keeps what goes through it, from the audio thread (nothing is lost when the page is
// busy, as a ScriptProcessor would), and hands it over at once.
class Recorder extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.buf = new Float32Array(Math.ceil(o.processorOptions.seconds * sampleRate));
    this.n = 0;
  }
  process(inputs) {
    const x = inputs[0][0];
    const len = Math.min(128, this.buf.length - this.n);
    if (x) this.buf.set(x.subarray(0, len), this.n);
    this.n += len;
    if (this.n < this.buf.length) return true;
    this.port.postMessage(this.buf);
    return false;
  }
}
registerProcessor('chud-test-recorder', Recorder);
