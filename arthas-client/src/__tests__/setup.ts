/**
 * Vitest 全局 Setup 文件
 *
 * 📚 学习要点: 测试 Setup 文件的作用
 * - 在所有测试文件执行前运行一次
 * - 扩展 Vitest 的 expect 断言，添加 DOM 相关的 matchers
 * - 例如：expect(element).toBeInTheDocument()、toHaveClass() 等
 * - 这些 matchers 来自 @testing-library/jest-dom，让 DOM 断言更语义化
 */
import '@testing-library/jest-dom';

/**
 * 📚 学习要点: Node 的实验性 localStorage 会遮蔽测试环境的实现
 * Node 22+ 自带一个 globalThis.localStorage，但只有在启动时传了
 * --localstorage-file 才可用，否则就是 undefined（并打印实验性警告）。
 * 它的存在会让 happy-dom 跳过自己的 Storage 注入，于是任何在模块顶层读取
 * localStorage 的代码（如 chatStore 的 muted 初始值）在导入期就抛错，
 * 整个测试文件连收集都失败。
 *
 * 这里在缺失时补一个内存实现。仅影响测试环境，不触及生产代码。
 */
if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage === null) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}
