/**
 * opus-recorder 没有自带类型声明，这里只声明本项目实际使用的部分。
 * @see opusEncoder.ts
 */
declare module 'opus-recorder' {
  export interface OpusRecorderConfig {
    /** 编码器 worker 的 URL（wasm 已内联在该文件中）。 */
    encoderPath?: string;
    /** 复用调用方已有的音频源；提供后由调用方负责关闭 AudioContext 和麦克风流。 */
    sourceNode?: MediaStreamAudioSourceNode;
    numberOfChannels?: number;
    /** 2048 = VOIP, 2049 = 全频带音频, 2051 = 低延迟。 */
    encoderApplication?: number;
    encoderBitRate?: number;
    encoderSampleRate?: number;
    encoderComplexity?: number;
    /** false = 仅在 stop() 时一次性产出完整文件。 */
    streamPages?: boolean;
  }

  export default class Recorder {
    constructor(config?: OpusRecorderConfig);
    static isRecordingSupported(): boolean;
    ondataavailable: ((page: Uint8Array) => void) | null;
    onstart: (() => void) | null;
    onstop: (() => void) | null;
    start(): Promise<void>;
    stop(): Promise<void> | void;
    close(): void;
  }
}
