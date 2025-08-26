// js/pcm-writer-processor.js
class PCMWriterProcessor extends AudioWorkletProcessor {
  process(inputs){
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const L = input[0], R = input[1] || input[0];
    this.port.postMessage({ type:'pcm', left: L.slice(0), right: R.slice(0) });
    return true;
  }
}
registerProcessor('pcm-writer', PCMWriterProcessor);
