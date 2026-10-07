/**
 * @file opus-ml-stub.ts — 替换掉未使用的 4MB ML 解码器
 *
 * ogg-opus-decoder 只有在构造时传入 speechQualityEnhancement 才会动态
 * import @wasm-audio-decoders/opus-ml（约 4MB wasm）。本项目不使用该选项，
 * 但打包器仍会为这个 import 生成一个永远不会被请求的 chunk。
 *
 * 由于前端 dist/ 会被 go:embed 嵌进服务器二进制，这 4MB 会直接变成镜像体积，
 * 而项目的卖点之一正是「镜像 < 30MB」。这里用空实现替换它。
 *
 * 如果将来真的要启用语音增强，删掉 vite.config.ts 中的这条 alias 即可。
 */
export const OpusMLDecoder = undefined;
export const OpusMLDecoderWebWorker = undefined;
